"""
nexo — nightly GBM training job.

Runs from GitHub Actions. Pulls the predictions journal from Supabase,
builds a feature matrix using the same scorers the browser uses, fits
a LightGBM binary classifier, evaluates on a 20% holdout, and upserts
the model to model_weights. Promotes if AUC improves by at least
IMPROVEMENT_THRESHOLD over the currently-active model.

Environment:
  SUPABASE_URL
  SUPABASE_SECRET_KEY  (service role)

Usage:
  python scripts/train_gbm.py
"""

import os
import sys
import json
import hashlib
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score, brier_score_loss, log_loss
from supabase import create_client, Client

from features import (
    FEATURE_NAMES,
    LEAK_SAFE_FEATURE_NAMES,
    extract_feature_vector,
    channel_bucket,
)

# Features actually fed to LightGBM. We train on the leak-safe subset (see
# features.py) so the booster cannot cheat using pay/mod/modCount, which get
# mutated by the cancellation event itself. Inference in lib/gbm.js reads the
# model's own feature_names list, so it will correctly build a matching
# vector at predict time and ignore the leaky ones.
TRAIN_FEATURE_NAMES = LEAK_SAFE_FEATURE_NAMES

# Monotonic constraints. LightGBM uses these to force a learned function to
# move only in the specified direction for a given feature. Encodes domain
# knowledge, reduces overfit on small datasets, and makes predictions more
# robust to distribution shift. Values: +1 prediction must increase with the
# feature, -1 must decrease, 0 unconstrained (default).
#
#   lt     — score_lead_time returns higher values for longer lead times,
#            and long-lead-time bookings cancel more often. (+1)
#   repeat — score_repeat returns positive values only for customers who
#            have cancelled before, so higher → higher cancel risk. (+1)
#
# Everything else stays unconstrained — e.g. `bookHour` is U-shaped (late-
# night + early-morning both suspicious), so no monotonic pattern applies.
MONOTONIC_CONSTRAINTS = {"lt": 1, "repeat": 1}

# ─── CONFIG ───
MIN_SAMPLES = 300              # below this we refuse to train
MIN_POSITIVES = 50
MIN_NEGATIVES = 50
IMPROVEMENT_THRESHOLD = 0.005  # AUC delta required to promote
TRAIN_WINDOW_DAYS = 450        # ~15 months — matches the backfill range
TEST_FRACTION = 0.2
RANDOM_SEED = 42

# LightGBM hyperparameters — tuned for small datasets (~3-5k rows)
LGB_PARAMS = {
    "objective": "binary",
    "metric": "binary_logloss",
    "boosting_type": "gbdt",
    "num_leaves": 15,
    "learning_rate": 0.05,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "min_child_samples": 20,
    "min_split_gain": 1e-5,
    "lambda_l1": 0.1,
    "lambda_l2": 0.1,
    "verbose": -1,
    "is_unbalance": True,  # auto-weight minority class
    "seed": RANDOM_SEED,
}


def log(msg: str) -> None:
    print(f"[train_gbm] {msg}", flush=True)


def get_client() -> Client:
    # .strip() is load-bearing: GitHub Actions secrets sometimes pick up a
    # trailing newline when you paste them in the dashboard, and httpx then
    # rejects the URL with "Invalid non-printable ASCII character '\n' at
    # position N". Same failure mode for keys. Stripping here makes the job
    # idempotent to paste mistakes.
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (
        (os.environ.get("SUPABASE_SECRET_KEY") or "").strip()
        or (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
    )
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY env vars required")
    return create_client(url, key)


def fetch_training_data(sb: Client) -> list[tuple[dict, int]]:
    """Return raw (features_dict, label) pairs from the journal.

    No cohort, no X/y — cohort_rates is computed downstream from the TRAIN
    split only (see build_cohort_rates) so test-row outcomes can't leak into
    the lookup the model is trained against.
    """
    window_start = (datetime.now(timezone.utc) - timedelta(days=TRAIN_WINDOW_DAYS)).date().isoformat()

    # We include ALL rows with outcomes (including backfill) for training.
    # Backfill rows are labeled real outcomes just without a live prediction —
    # they're valid training data even though they don't count toward the
    # /api/model retrospective accuracy stats.
    log(f"Querying predictions with outcome_final_at >= {window_start}...")

    # Supabase (PostgREST) caps each response at ~1000 rows regardless of
    # .limit(). We paginate with .range() to get all training data.
    PAGE = 1000
    rows = []
    page = 0
    while True:
        lo = page * PAGE
        hi = lo + PAGE - 1
        resp = (
            sb.table("predictions")
              .select("features, outcome")
              .not_.is_("outcome", "null")
              .not_.is_("outcome_final_at", "null")
              .gte("outcome_final_at", window_start)
              .range(lo, hi)
              .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        page += 1
        if page >= 100:  # safety: 100k rows max
            break

    log(f"Fetched {len(rows)} closed predictions ({page + 1} pages)")

    pairs: list[tuple[dict, int]] = []
    skipped = 0
    for row in rows:
        features = row.get("features") or {}
        outcome = row.get("outcome")
        if outcome == "cancelled" or outcome == "no_show":
            label = 1
        elif outcome == "stayed":
            label = 0
        else:
            skipped += 1
            continue
        pairs.append((features, label))

    log(f"Collected {len(pairs)} labelled pairs, {skipped} skipped")
    return pairs


def build_cohort_rates(pairs: list[tuple[dict, int]]) -> dict:
    """Build the (channel_bucket × arrival_month) cancel-rate lookup from the
    given pairs. Cell shape `{"rate": float, "count": int}` plus an "_all"
    entry for the global base rate. MUST be called with the TRAIN split only —
    using the full set leaks test-row outcomes into the table the model is
    scored against."""
    cohort_counts: dict = {}  # key -> {"cancels": int, "total": int}
    all_counts = {"cancels": 0, "total": 0}
    for features, label in pairs:
        bucket = channel_bucket(features.get("source"))
        arr_month = features.get("arrMonth") or 0
        key = f"{bucket}_{arr_month}"
        cell = cohort_counts.setdefault(key, {"cancels": 0, "total": 0})
        cell["total"] += 1
        all_counts["total"] += 1
        if label == 1:
            cell["cancels"] += 1
            all_counts["cancels"] += 1

    cohort_rates = {
        k: {"rate": v["cancels"] / v["total"], "count": v["total"]}
        for k, v in cohort_counts.items()
    }
    cohort_rates["_all"] = {
        "rate": (all_counts["cancels"] / all_counts["total"]) if all_counts["total"] else 0.0,
        "count": all_counts["total"],
    }
    return cohort_rates


def build_feature_matrix(pairs: list[tuple[dict, int]], cohort_rates: dict) -> tuple[list, list, int]:
    """Turn pairs into (X, y, skipped_count) using the given cohort table."""
    X, y = [], []
    skipped = 0
    for features, label in pairs:
        try:
            fv = extract_feature_vector(features, cohort_rates)
            X.append([fv[name] for name in TRAIN_FEATURE_NAMES])
            y.append(label)
        except Exception as e:
            log(f"  skip row: {e}")
            skipped += 1
    return X, y, skipped


def seeded_split_pairs(pairs: list[tuple[dict, int]], test_frac: float, seed: int) -> tuple[list, list]:
    """Deterministic split on raw pairs — same seed → same partition across
    runs. Mirrors the old seeded_split(X, y) but keeps us operating on the
    (features, label) tuples so build_cohort_rates can run on TRAIN only."""
    n = len(pairs)
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    n_test = int(round(n * test_frac))
    test_idx = set(idx[:n_test].tolist())
    train_pairs, test_pairs = [], []
    for i in range(n):
        (test_pairs if i in test_idx else train_pairs).append(pairs[i])
    return train_pairs, test_pairs


def calibration_error(y_true, y_pred, n_buckets=10):
    """Expected Calibration Error with equal-width bins."""
    bins = np.linspace(0, 1, n_buckets + 1)
    idx = np.digitize(y_pred, bins) - 1
    idx = np.clip(idx, 0, n_buckets - 1)
    total = len(y_true)
    ece = 0.0
    for b in range(n_buckets):
        mask = idx == b
        if not mask.any():
            continue
        avg_p = float(y_pred[mask].mean())
        actual = float(y_true[mask].mean())
        ece += (mask.sum() / total) * abs(avg_p - actual)
    return ece


def reliability_buckets(y_true, y_pred, n_buckets=10):
    """Return list matching lib/logistic.js reliabilityBuckets format."""
    bins = np.linspace(0, 1, n_buckets + 1)
    idx = np.digitize(y_pred, bins) - 1
    idx = np.clip(idx, 0, n_buckets - 1)
    out = []
    for b in range(n_buckets):
        mask = idx == b
        count = int(mask.sum())
        if count > 0:
            out.append({
                "bin": (b + 0.5) / n_buckets,
                "avg_pred": float(y_pred[mask].mean()),
                "actual_rate": float(y_true[mask].mean()),
                "count": count,
            })
        else:
            out.append({
                "bin": (b + 0.5) / n_buckets,
                "avg_pred": 0.0,
                "actual_rate": 0.0,
                "count": 0,
            })
    return out


def simplify_tree(node: dict) -> dict:
    """Walk a LightGBM tree dump node and emit a minimal JS-friendly structure."""
    if "leaf_value" in node or "leaf_index" in node:
        return {"leaf": float(node.get("leaf_value", 0.0))}
    return {
        "feature": int(node["split_feature"]),
        "threshold": float(node["threshold"]),
        "left": simplify_tree(node["left_child"]),
        "right": simplify_tree(node["right_child"]),
        # LightGBM missing-value direction: 0=none, 1=left, 2=right
        "default_left": node.get("default_left", False) is True,
    }


def export_model(booster: lgb.Booster, feature_names: list, metrics: dict, n_train: int, cohort_rates: dict = None) -> dict:
    """Export a LightGBM booster to the JSON shape lib/gbm.js expects."""
    dump = booster.dump_model()
    trees = []
    for t in dump["tree_info"]:
        trees.append(simplify_tree(t["tree_structure"]))

    # Find the best iteration if early stopping was used
    best_iter = booster.best_iteration or booster.current_iteration()

    return {
        "algorithm": "gbm",
        "lightgbm_version": dump.get("version"),
        "feature_names": feature_names,
        "num_trees": len(trees),
        "best_iteration": best_iter,
        "trees": trees,
        # For binary classification, LightGBM uses raw margins (logit space)
        # that need sigmoid activation. Store this flag so the JS inferencer
        # knows to apply it.
        "apply_sigmoid": True,
        # Cohort lookup table for the channelMonthRate feature. Empty dict
        # when training with < MIN_COHORT_CELLS — scorer falls back to the
        # global prior. See scoreChannelMonthRate in lib/features.js.
        "cohort_rates": cohort_rates or {},
        "training": {
            "samples": n_train,
            "created_at": datetime.now(timezone.utc).isoformat(),
        },
        "metrics": metrics,
    }


def get_active_model(sb: Client):
    resp = (
        sb.table("model_weights")
          .select("version, auc")
          .eq("is_active", True)
          .limit(1)
          .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def promote(sb: Client, new_version: str, old_version: str | None) -> None:
    """Atomically swap the active model.

    The model_weights table has a partial unique index that enforces at
    most one is_active=true (model_weights_single_active). We CANNOT
    activate-new-first: PostgREST rejects with 23505 even for a transient
    dual-active state. So: deactivate old, activate new, and on activation
    failure roll back (re-activate old) so we never end up zero-active.
    """
    if old_version:
        log(f"Deactivating {old_version}...")
        sb.table("model_weights").update({"is_active": False}).eq("version", old_version).execute()

    log(f"Activating {new_version}...")
    try:
        sb.table("model_weights").update({"is_active": True}).eq("version", new_version).execute()
    except Exception as act_err:
        log(f"ERROR: activation of {new_version} failed: {act_err}")
        if old_version:
            log(f"ROLLBACK: re-activating {old_version}")
            try:
                sb.table("model_weights").update({"is_active": True}).eq("version", old_version).execute()
                log(f"Rollback succeeded — {old_version} is active again")
            except Exception as rb_err:
                log(f"CRITICAL: rollback also failed — ZERO ACTIVE MODELS. Manual reconcile needed: {rb_err}")
        raise


def main() -> int:
    started = time.time()
    sb = get_client()

    pairs = fetch_training_data(sb)
    if len(pairs) < MIN_SAMPLES:
        log(f"Skipping: {len(pairs)} < {MIN_SAMPLES} samples minimum")
        return 0
    n_pos = sum(label for _, label in pairs)
    n_neg = len(pairs) - n_pos
    if n_pos < MIN_POSITIVES or n_neg < MIN_NEGATIVES:
        log(f"Skipping: positives={n_pos}, negatives={n_neg} — need ≥{MIN_POSITIVES}/{MIN_NEGATIVES}")
        return 0

    log(f"Class balance: {n_pos} positives / {n_neg} negatives ({100*n_pos/(n_pos+n_neg):.1f}% cancel rate)")

    # Split BEFORE building the cohort table so test-row outcomes can't leak
    # into the lookup the model is trained (and then evaluated) against.
    train_pairs, test_pairs = seeded_split_pairs(pairs, TEST_FRACTION, RANDOM_SEED)
    log(f"Split: {len(train_pairs)} train / {len(test_pairs)} test")

    cohort_rates = build_cohort_rates(train_pairs)
    log(f"Cohort table: {len(cohort_rates) - 1} cells (training-only), "
        f"overall train cancel rate {100 * cohort_rates['_all']['rate']:.1f}%")

    X_tr_list, y_tr_list, _ = build_feature_matrix(train_pairs, cohort_rates)
    X_te_list, y_te_list, _ = build_feature_matrix(test_pairs, cohort_rates)
    X_tr = np.array(X_tr_list)
    y_tr = np.array(y_tr_list)
    X_te = np.array(X_te_list)
    y_te = np.array(y_te_list)

    train_set = lgb.Dataset(X_tr, y_tr, feature_name=TRAIN_FEATURE_NAMES, free_raw_data=False)
    valid_set = lgb.Dataset(X_te, y_te, feature_name=TRAIN_FEATURE_NAMES, reference=train_set, free_raw_data=False)

    # Build monotonic constraints as a positional list matching
    # TRAIN_FEATURE_NAMES. Unconstrained features get 0. LightGBM accepts
    # this as the `monotone_constraints` param.
    mc_list = [MONOTONIC_CONSTRAINTS.get(name, 0) for name in TRAIN_FEATURE_NAMES]
    train_params = dict(LGB_PARAMS)
    train_params["monotone_constraints"] = mc_list
    active_constraints = [f"{n}={MONOTONIC_CONSTRAINTS[n]:+d}" for n in TRAIN_FEATURE_NAMES if n in MONOTONIC_CONSTRAINTS]
    log(f"Monotonic constraints: {', '.join(active_constraints) if active_constraints else 'none'}")

    log("Training LightGBM...")
    booster = lgb.train(
        train_params,
        train_set,
        num_boost_round=300,
        valid_sets=[valid_set],
        valid_names=["holdout"],
        callbacks=[
            lgb.early_stopping(stopping_rounds=25, verbose=False),
            lgb.log_evaluation(period=0),  # silence
        ],
    )
    log(f"Stopped at iteration {booster.best_iteration}")

    pred_test = booster.predict(X_te)
    auc = float(roc_auc_score(y_te, pred_test))
    brier = float(brier_score_loss(y_te, pred_test))
    ll = float(log_loss(y_te, pred_test))
    ece = float(calibration_error(y_te, pred_test))
    buckets = reliability_buckets(y_te, pred_test)

    log(f"Metrics — AUC: {auc:.4f}, Brier: {brier:.4f}, LogLoss: {ll:.4f}, ECE: {ece:.4f}")

    # Version string. Hash input includes the full ISO timestamp (with
    # microseconds) so that two runs with identical training data + identical
    # AUC still produce distinct version strings. Without this, re-triggering
    # the workflow (or the new-run collision we hit after the PR C promotion
    # bug) fails with "duplicate key value violates unique constraint
    # model_weights_pkey" on the insert.
    now_utc = datetime.now(timezone.utc)
    today = now_utc.date().isoformat()
    hash_input = f"{now_utc.isoformat()}-{auc:.6f}"
    short_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:6]
    version = f"gbm-{today}-{short_hash}"

    # Build export and upsert. The model's feature_names is the leak-safe
    # subset — lib/gbm.js builds its input vector from whatever list it sees
    # here, so the JS inferencer automatically skips pay/mod/modCount too.
    # cohort_rates travels with the model so scoreChannelMonthRate resolves
    # against the same lookup table used during training.
    model_json = export_model(booster, TRAIN_FEATURE_NAMES, {
        "auc": auc, "brier": brier, "log_loss": ll, "calibration_error": ece,
    }, len(X_tr), cohort_rates)

    today_date = datetime.now(timezone.utc).date().isoformat()
    window_start_date = (datetime.now(timezone.utc) - timedelta(days=TRAIN_WINDOW_DAYS)).date().isoformat()

    row = {
        "version": version,
        "coefs": model_json,  # jsonb — whole tree structure goes here
        "feature_names": TRAIN_FEATURE_NAMES,
        "training_samples": len(X_tr),
        "training_window_start": window_start_date,
        "training_window_end": today_date,
        "auc": auc,
        "brier": brier,
        "log_loss": ll,
        "calibration_error": ece,
        "is_active": False,
    }

    log("Inserting model_weights row...")
    sb.table("model_weights").insert(row).execute()

    # Promote if we beat the active one.
    # FORCE_PROMOTE env var skips the AUC comparison — needed once to
    # bootstrap past the broken logistic that claimed AUC 1.0000.
    force = os.environ.get("FORCE_PROMOTE", "").strip().lower() in ("1", "true", "yes")
    active = get_active_model(sb)
    current_auc = float(active["auc"]) if active and active.get("auc") is not None else 0.0
    promoted = False
    if force:
        promote(sb, version, active["version"] if active else None)
        promoted = True
        log(f"FORCE-PROMOTED: new AUC {auc:.4f} (forced, skipping comparison with {current_auc:.4f})")
    elif auc >= current_auc + IMPROVEMENT_THRESHOLD:
        promote(sb, version, active["version"] if active else None)
        promoted = True
        log(f"PROMOTED: new AUC {auc:.4f} > current {current_auc:.4f} + {IMPROVEMENT_THRESHOLD}")
    else:
        log(f"Not promoted: new AUC {auc:.4f} < current {current_auc:.4f} + {IMPROVEMENT_THRESHOLD}")

    # Snapshot into model_performance
    perf = {
        "model_version": version,
        "window_start": window_start_date,
        "window_end": today_date,
        "samples": len(X_te),
        "auc": auc,
        "brier": brier,
        "log_loss": ll,
        "calibration_error": ece,
        "reliability_buckets": buckets,
    }
    sb.table("model_performance").insert(perf).execute()

    elapsed = time.time() - started
    log(f"Done in {elapsed:.1f}s — version={version}, promoted={promoted}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[train_gbm] FATAL: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
