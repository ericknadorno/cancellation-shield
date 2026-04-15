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
)

# Features actually fed to LightGBM. We train on the leak-safe subset (see
# features.py) so the booster cannot cheat using pay/mod/modCount, which get
# mutated by the cancellation event itself. Inference in lib/gbm.js reads the
# model's own feature_names list, so it will correctly build a 24-long vector
# at predict time and ignore the three leaky ones.
TRAIN_FEATURE_NAMES = LEAK_SAFE_FEATURE_NAMES

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
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY env vars required")
    return create_client(url, key)


def fetch_training_data(sb: Client) -> tuple[list, list]:
    """Return X (n × len(FEATURE_NAMES)) and y (length n) from the journal."""
    window_start = (datetime.now(timezone.utc) - timedelta(days=TRAIN_WINDOW_DAYS)).date().isoformat()

    # We include ALL rows with outcomes (including backfill) for training.
    # Backfill rows are labeled real outcomes just without a live prediction —
    # they're valid training data even though they don't count toward the
    # /api/model retrospective accuracy stats.
    log(f"Querying predictions with outcome_final_at >= {window_start}...")
    resp = (
        sb.table("predictions")
          .select("features, outcome")
          .not_.is_("outcome", "null")
          .not_.is_("outcome_final_at", "null")
          .gte("outcome_final_at", window_start)
          .limit(50000)
          .execute()
    )

    rows = resp.data or []
    log(f"Fetched {len(rows)} closed predictions")

    X, y = [], []
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
        try:
            fv = extract_feature_vector(features)
            # Only the leak-safe features go into the training matrix.
            X.append([fv[name] for name in TRAIN_FEATURE_NAMES])
            y.append(label)
        except Exception as e:
            log(f"  skip row: {e}")
            skipped += 1

    log(f"Built matrix: {len(X)} samples, {skipped} skipped "
        f"({len(TRAIN_FEATURE_NAMES)} leak-safe features / "
        f"{len(FEATURE_NAMES)} total scorers)")
    return X, y


def seeded_split(X: list, y: list, test_frac: float, seed: int):
    """Deterministic split — same seed → same partition across runs."""
    n = len(X)
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    n_test = int(round(n * test_frac))
    test_idx = set(idx[:n_test].tolist())
    X_tr, y_tr, X_te, y_te = [], [], [], []
    for i in range(n):
        if i in test_idx:
            X_te.append(X[i])
            y_te.append(y[i])
        else:
            X_tr.append(X[i])
            y_tr.append(y[i])
    return np.array(X_tr), np.array(y_tr), np.array(X_te), np.array(y_te)


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


def export_model(booster: lgb.Booster, feature_names: list, metrics: dict, n_train: int) -> dict:
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
    if old_version:
        log(f"Deactivating {old_version}...")
        sb.table("model_weights").update({"is_active": False}).eq("version", old_version).execute()
    log(f"Activating {new_version}...")
    sb.table("model_weights").update({"is_active": True}).eq("version", new_version).execute()


def main() -> int:
    started = time.time()
    sb = get_client()

    X, y = fetch_training_data(sb)
    if len(X) < MIN_SAMPLES:
        log(f"Skipping: {len(X)} < {MIN_SAMPLES} samples minimum")
        return 0
    n_pos = sum(y)
    n_neg = len(y) - n_pos
    if n_pos < MIN_POSITIVES or n_neg < MIN_NEGATIVES:
        log(f"Skipping: positives={n_pos}, negatives={n_neg} — need ≥{MIN_POSITIVES}/{MIN_NEGATIVES}")
        return 0

    log(f"Class balance: {n_pos} positives / {n_neg} negatives ({100*n_pos/(n_pos+n_neg):.1f}% cancel rate)")

    X_tr, y_tr, X_te, y_te = seeded_split(X, y, TEST_FRACTION, RANDOM_SEED)
    log(f"Split: {len(X_tr)} train / {len(X_te)} test")

    train_set = lgb.Dataset(X_tr, y_tr, feature_name=TRAIN_FEATURE_NAMES, free_raw_data=False)
    valid_set = lgb.Dataset(X_te, y_te, feature_name=TRAIN_FEATURE_NAMES, reference=train_set, free_raw_data=False)

    log("Training LightGBM...")
    booster = lgb.train(
        LGB_PARAMS,
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

    # Version string
    today = datetime.now(timezone.utc).date().isoformat()
    short_hash = hashlib.sha256(f"{today}{auc:.4f}".encode()).hexdigest()[:6]
    version = f"gbm-{today}-{short_hash}"

    # Build export and upsert. The model's feature_names is the leak-safe
    # subset — lib/gbm.js builds its input vector from whatever list it sees
    # here, so the JS inferencer automatically skips pay/mod/modCount too.
    model_json = export_model(booster, TRAIN_FEATURE_NAMES, {
        "auc": auc, "brier": brier, "log_loss": ll, "calibration_error": ece,
    }, len(X_tr))

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

    # Promote if we beat the active one
    active = get_active_model(sb)
    current_auc = float(active["auc"]) if active and active.get("auc") is not None else 0.0
    promoted = False
    if auc >= current_auc + IMPROVEMENT_THRESHOLD:
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
