// nexo — online learning cron.
//
// Every night at 04:30 UTC this runs (after /api/outcomes at 04:00 UTC
// populates the journal with fresh labels). It:
//
//   1. Queries all closed predictions from the last 12 months
//   2. Builds feature matrix X and binary label vector y
//      (cancelled=1, stayed=0, no_show=1 — operationally a cancellation)
//   3. 80/20 deterministic train/test split
//   4. Fits L2-regularized logistic regression via Newton-Raphson
//   5. Evaluates AUC / Brier / log-loss / calibration error on holdout
//   6. Inserts a new row into `model_weights`
//   7. If AUC improves by at least 0.005 over the active model,
//      marks the new version as active (and deactivates the old)
//   8. Writes a snapshot into `model_performance` regardless of promotion

import { getServerClient } from "../lib/supabase.js";
import {
  LEAK_SAFE_FEATURE_NAMES,
  extractFeatureVector
} from "../lib/features.js";

// Train on the leak-safe subset only. pay/mod/modCount are post-hoc — they
// flip the moment the cancellation event happens, so letting the learner see
// them yields a trivially perfect holdout AUC and a useless live model.
// Inference (scoreLearned in api/score.js) iterates FEATURE_NAMES and skips
// any key not present in coefs, so the full 27-feature vector still flows
// through the UI — the model just can't cheat with the leaky three.
const TRAIN_FEATURE_NAMES = LEAK_SAFE_FEATURE_NAMES;
import {
  fitLogistic,
  predictProb,
  auc,
  brier,
  logLoss,
  reliabilityBuckets,
  expectedCalibrationError,
  trainTestSplit
} from "../lib/logistic.js";

// Minimum data required to train. Below this, we refuse to train and
// the hand-tuned model stays active.
const MIN_SAMPLES = 100;
const MIN_POSITIVES = 20;
const MIN_NEGATIVES = 20;

// How much the new model has to beat the active one before we deploy it.
// Prevents thrashing from noisy training sets.
const AUC_IMPROVEMENT_THRESHOLD = 0.005;

// Training window: rows with outcome_final_at within this many days
const TRAIN_WINDOW_DAYS = 365;

// L2 regularization strength
const LAMBDA = 1.0;

function labelFromOutcome(outcome) {
  if (outcome === "cancelled" || outcome === "no_show") return 1;
  if (outcome === "stayed") return 0;
  return null;  // 'other' or unknown — skip
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET or POST only" });
  }

  // Optional cron auth
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.authorization || "";
    if (header !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const startedAt = Date.now();
  const sb = getServerClient();

  try {
    // ─── 1. Query closed predictions ───
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - TRAIN_WINDOW_DAYS);
    const windowStartStr = windowStart.toISOString();

    // Supabase (PostgREST) caps responses at ~1000 rows regardless of
    // .limit(). Paginate with .range() to get all training data.
    const PAGE = 1000;
    const rows = [];
    let page = 0;
    while (true) {
      const lo = page * PAGE;
      const hi = lo + PAGE - 1;
      const { data: batch, error: qErr } = await sb
        .from("predictions")
        .select("features, outcome, outcome_final_at")
        .not("outcome", "is", null)
        .not("outcome_final_at", "is", null)
        .gte("outcome_final_at", windowStartStr)
        .range(lo, hi);
      if (qErr) throw new Error(`Query failed (page ${page}): ${qErr.message}`);
      if (batch) rows.push(...batch);
      if (!batch || batch.length < PAGE) break;
      page++;
      if (page >= 100) break; // safety: 100k max
    }

    if (rows.length === 0) {
      return res.status(200).json({
        status: "skipped",
        reason: "no_closed_predictions",
        duration_ms: Date.now() - startedAt
      });
    }

    // ─── 2. Build X, y ───
    const X = [];
    const y = [];
    let pos = 0, neg = 0, skipped = 0;

    for (const row of rows) {
      const label = labelFromOutcome(row.outcome);
      if (label === null) { skipped++; continue; }
      const fv = extractFeatureVector(row.features || {});
      // Only the leak-safe columns go into the training matrix.
      const xi = TRAIN_FEATURE_NAMES.map(k => fv[k] ?? 0);
      X.push(xi);
      y.push(label);
      if (label === 1) pos++; else neg++;
    }

    if (X.length < MIN_SAMPLES || pos < MIN_POSITIVES || neg < MIN_NEGATIVES) {
      return res.status(200).json({
        status: "skipped",
        reason: "insufficient_data",
        samples: X.length,
        positives: pos,
        negatives: neg,
        min_samples: MIN_SAMPLES,
        min_positives: MIN_POSITIVES,
        min_negatives: MIN_NEGATIVES,
        duration_ms: Date.now() - startedAt
      });
    }

    // ─── 3. Split ───
    const { Xtr, ytr, Xte, yte } = trainTestSplit(X, y, 0.2, 42);

    // ─── 4. Fit ───
    const beta = fitLogistic(Xtr, ytr, { lambda: LAMBDA, maxIter: 50, tol: 1e-6 });

    // ─── 5. Evaluate on holdout ───
    const predTest = predictProb(Xte, beta);
    const newAUC = auc(yte, predTest);
    const newBrier = brier(yte, predTest);
    const newLogLoss = logLoss(yte, predTest);
    const newECE = expectedCalibrationError(yte, predTest, 10);
    const buckets = reliabilityBuckets(yte, predTest, 10);

    // ─── 6. Compare against active model ───
    const { data: activeRow } = await sb
      .from("model_weights")
      .select("version, auc, coefs")
      .eq("is_active", true)
      .maybeSingle();

    const currentAUC = activeRow?.auc || 0;
    const shouldPromote = newAUC >= currentAUC + AUC_IMPROVEMENT_THRESHOLD;

    // ─── 7. Build coefs object ───
    // coefs[key] is only set for the features that actually entered training.
    // scoreLearned in api/score.js walks FEATURE_NAMES and skips keys missing
    // here, so pay/mod/modCount contribute 0 to the logit — no leakage.
    const coefs = { intercept: beta[0] };
    TRAIN_FEATURE_NAMES.forEach((name, i) => {
      coefs[name] = beta[i + 1];
    });

    // Version: ISO date + short hash for uniqueness
    const today = new Date().toISOString().slice(0, 10);
    const shortHash = Math.random().toString(36).slice(2, 8);
    const version = `learned-${today}-${shortHash}`;

    // Insert new weights row. feature_names records the leak-safe subset so
    // downstream consumers know which columns were actually learned.
    const newRow = {
      version,
      coefs,
      feature_names: TRAIN_FEATURE_NAMES,
      training_samples: Xtr.length,
      training_window_start: windowStart.toISOString().slice(0, 10),
      training_window_end: new Date().toISOString().slice(0, 10),
      auc: newAUC,
      brier: newBrier,
      log_loss: newLogLoss,
      calibration_error: newECE,
      is_active: false  // atomic swap below if promoted
    };

    const { error: insErr } = await sb.from("model_weights").insert(newRow);
    if (insErr) throw new Error(`Insert new weights failed: ${insErr.message}`);

    // ─── 8. Promote atomically if improved ───
    let promoted = false;
    if (shouldPromote) {
      // Deactivate current active
      if (activeRow) {
        const { error: deactErr } = await sb
          .from("model_weights")
          .update({ is_active: false })
          .eq("version", activeRow.version);
        if (deactErr) console.error("[train] deactivate failed:", deactErr.message);
      }

      // Activate new
      const { error: actErr } = await sb
        .from("model_weights")
        .update({ is_active: true })
        .eq("version", version);
      if (actErr) throw new Error(`Activate new model failed: ${actErr.message}`);

      promoted = true;
    }

    // ─── 9. Snapshot into model_performance regardless ───
    const perfRow = {
      model_version: version,
      window_start: windowStart.toISOString().slice(0, 10),
      window_end: new Date().toISOString().slice(0, 10),
      samples: Xte.length,
      auc: newAUC,
      brier: newBrier,
      log_loss: newLogLoss,
      calibration_error: newECE,
      reliability_buckets: buckets
    };
    const { error: perfErr } = await sb.from("model_performance").insert(perfRow);
    if (perfErr) console.error("[train] performance insert failed:", perfErr.message);

    return res.status(200).json({
      status: "ok",
      version,
      samples_total: X.length,
      samples_train: Xtr.length,
      samples_test: Xte.length,
      positives: pos,
      negatives: neg,
      skipped,
      metrics: {
        auc: newAUC,
        brier: newBrier,
        log_loss: newLogLoss,
        calibration_error: newECE
      },
      previous_auc: currentAUC,
      auc_improvement: newAUC - currentAUC,
      promoted,
      reason_not_promoted: promoted ? null : `new AUC ${newAUC.toFixed(4)} < current ${currentAUC.toFixed(4)} + ${AUC_IMPROVEMENT_THRESHOLD}`,
      duration_ms: Date.now() - startedAt
    });
  } catch (err) {
    console.error("[train] fatal:", err.message);
    return res.status(500).json({
      error: "Training failed",
      message: err.message,
      duration_ms: Date.now() - startedAt
    });
  }
}
