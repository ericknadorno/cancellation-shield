// nexo — model dashboard endpoint.
//
// GET /api/model
//   Returns everything the "Modelo" tab needs in one call:
//   - active:             current active model row (version, coefs, metrics, created_at)
//   - history:            last 30 model_performance snapshots (for timeline charts)
//   - latest_buckets:     most recent 10-bucket reliability diagram
//   - feature_importances: sorted list of { name, coef, abs_coef } from active coefs
//   - journal_stats:      rows, with_outcome, positive_rate, last_snapshot_at
//
// POST /api/model
//   Triggers an ad-hoc training run by proxying to /api/train. Returns the
//   same payload as /api/train. Used by the "Forçar retreino" button in UI.

import { getServerClient } from "../lib/supabase.js";
import trainHandler from "./train.js";

async function gatherDashboardData(sb) {
  // Active model
  const { data: active, error: actErr } = await sb
    .from("model_weights")
    .select("version, created_at, coefs, feature_names, training_samples, training_window_start, training_window_end, auc, brier, log_loss, calibration_error")
    .eq("is_active", true)
    .maybeSingle();
  if (actErr) console.warn("[model] active lookup:", actErr.message);

  // Last 30 performance snapshots
  const { data: history, error: histErr } = await sb
    .from("model_performance")
    .select("model_version, evaluated_at, samples, auc, brier, log_loss, calibration_error, reliability_buckets")
    .order("evaluated_at", { ascending: false })
    .limit(30);
  if (histErr) console.warn("[model] history:", histErr.message);

  // Journal stats (lightweight — 2 cheap counts)
  let journalStats = null;
  try {
    const { count: total } = await sb
      .from("predictions")
      .select("*", { count: "exact", head: true });
    const { count: withOutcome } = await sb
      .from("predictions")
      .select("*", { count: "exact", head: true })
      .not("outcome", "is", null);
    const { count: cancelled } = await sb
      .from("predictions")
      .select("*", { count: "exact", head: true })
      .in("outcome", ["cancelled", "no_show"]);
    const { data: latestRow } = await sb
      .from("predictions")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    journalStats = {
      total_rows: total || 0,
      rows_with_outcome: withOutcome || 0,
      rows_cancelled: cancelled || 0,
      positive_rate: (withOutcome && withOutcome > 0) ? (cancelled || 0) / withOutcome : null,
      last_snapshot_date: latestRow?.snapshot_date || null
    };
  } catch (err) {
    console.warn("[model] journal stats:", err.message);
  }

  // Feature importances from the active coefs (sorted by |coef|)
  // Raw coefficients aren't directly comparable unless feature variances are
  // roughly matched, but since every score* function returns a value in a
  // similar 0-100 range, |coef| is a reasonable proxy for importance here.
  let featureImportances = [];
  if (active?.coefs) {
    featureImportances = Object.entries(active.coefs)
      .filter(([k]) => k !== "intercept")
      .map(([name, coef]) => ({ name, coef, abs_coef: Math.abs(coef) }))
      .sort((a, b) => b.abs_coef - a.abs_coef);
  }

  // Latest reliability buckets (from the most recent history snapshot)
  const latestBuckets = history?.[0]?.reliability_buckets || [];

  // Recent closed predictions — the "retrospective" table.
  // Shows the most recent predictions where the outcome is known so staff
  // can audit the model: did it say 80% and actually cancel? Did it say
  // 5% and actually stay? This is the feedback loop made visible.
  //
  // CRITICAL: exclude backfill rows (model_version='backfill-v1'). Those
  // are historical reservations ingested from Mews with outcome already
  // known — they have predicted_prob=0 as a placeholder because no real
  // prediction was ever made. Including them poisons the accuracy stats:
  // every cancelled backfill row becomes a false negative and every stayed
  // row becomes a trivial true negative, masking the model's true
  // performance.
  let recentClosed = [];
  try {
    const { data: rc } = await sb
      .from("predictions")
      .select("reservation_id, prop, snapshot_date, features, predicted_prob, score, level, model_version, outcome, outcome_final_at")
      .not("outcome", "is", null)
      .neq("model_version", "backfill-v1")
      .order("outcome_final_at", { ascending: false })
      .limit(50);
    recentClosed = (rc || []).map(r => ({
      reservation_id: r.reservation_id,
      prop: r.prop,
      guest: r.features?.guest || "",
      arrival: r.features?.arrival || null,
      snapshot_date: r.snapshot_date,
      predicted_prob: r.predicted_prob,
      score: r.score,
      level: r.level,
      model_version: r.model_version,
      outcome: r.outcome,
      outcome_final_at: r.outcome_final_at,
      correct: (r.predicted_prob >= 0.5) === (r.outcome === "cancelled" || r.outcome === "no_show")
    }));
  } catch (err) {
    console.warn("[model] recent_closed:", err.message);
  }

  // Aggregate accuracy / precision / recall on the last 500 closed
  // predictions — populates the "Como estou a acertar?" headline KPIs.
  // Same backfill exclusion as recentClosed above — see comment there.
  let accuracyStats = null;
  try {
    const { data: agg } = await sb
      .from("predictions")
      .select("predicted_prob, outcome")
      .not("outcome", "is", null)
      .neq("model_version", "backfill-v1")
      .order("outcome_final_at", { ascending: false })
      .limit(500);
    if (agg && agg.length > 0) {
      let correct = 0, tp = 0, fp = 0, fn = 0, tn = 0;
      for (const row of agg) {
        const predCancel = row.predicted_prob >= 0.5;
        const actualCancel = row.outcome === "cancelled" || row.outcome === "no_show";
        if (predCancel === actualCancel) correct++;
        if (predCancel && actualCancel) tp++;
        if (predCancel && !actualCancel) fp++;
        if (!predCancel && actualCancel) fn++;
        if (!predCancel && !actualCancel) tn++;
      }
      accuracyStats = {
        sample: agg.length,
        accuracy: correct / agg.length,
        precision: (tp + fp) > 0 ? tp / (tp + fp) : null,
        recall: (tp + fn) > 0 ? tp / (tp + fn) : null,
        true_positives: tp,
        false_positives: fp,
        false_negatives: fn,
        true_negatives: tn
      };
    }
  } catch (err) {
    console.warn("[model] accuracy_stats:", err.message);
  }

  return {
    active: active || null,
    history: history || [],
    latest_buckets: latestBuckets,
    feature_importances: featureImportances,
    journal_stats: journalStats,
    recent_closed: recentClosed,
    accuracy_stats: accuracyStats
  };
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const isProd = process.env.VERCEL_ENV === "production";
  if (isProd && ALLOWED_ORIGINS.length === 0) {
    return res.status(500).json({ error: "Server misconfiguration: CORS unset" });
  }
  if (ALLOWED_ORIGINS.length > 0) {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const sb = getServerClient();
      const data = await gatherDashboardData(sb);
      return res.status(200).json(data);
    }

    if (req.method === "POST") {
      // Forced retrain — delegate to the train handler
      return trainHandler(req, res);
    }

    return res.status(405).json({ error: "GET or POST only" });
  } catch (err) {
    console.error("[model] fatal:", err.message);
    return res.status(500).json({ error: "Model dashboard failed", message: err.message });
  }
}
