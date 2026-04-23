// nexo — prediction history endpoint.
//
// GET /api/history?minProb=0.18&prop=alegria&verdict=all&limit=2000
//
// The "Histórico" tab's data source. For every reservation with a known
// outcome, returns the model's prediction alongside the ground truth so
// staff can audit case by case — "Reserva X teve 87%, cancelou mesmo".
//
// Two kinds of rows get folded into one stream:
//
//   1. LIVE predictions  — model_version != 'backfill-v1' AND
//                          predicted_prob > 0. The dashboard scored these
//                          at booking time; predicted_prob is what the
//                          model actually said that day.
//
//   2. RETROSPECTIVE predictions — model_version == 'backfill-v1' OR
//                                   predicted_prob == 0 (placeholder).
//                                   These are historical Mews imports
//                                   whose feature vectors we preserved
//                                   but never scored. Here we run the
//                                   current active model over them so
//                                   the user can still see the "what
//                                   would the model have said" answer.
//                                   Rows are marked `retrospective: true`.
//
// Without the retrospective bucket the panel is empty until many live
// predictions mature — weeks of waiting. With it, the full 15-month
// backfill is immediately inspectable.
//
// verdict classification (threshold 0.5):
//   hit           prob >= 0.5  AND outcome in {cancelled, no_show}
//   false_alarm   prob >= 0.5  AND outcome == stayed
//   missed        prob <  0.5  AND outcome in {cancelled, no_show}
//   stayed_ok     prob <  0.5  AND outcome == stayed

import { getServerClient } from "../lib/supabase.js";
import { applyCors } from "../lib/cors.js";
import { extractRiskFactors } from "../lib/features.js";
import { computeRisk } from "./score.js";

const DEFAULT_MIN_PROB = 0.18;   // MEDIUM floor, matches the 18% UI threshold
const HARD_LIMIT       = 2000;   // never ship more than this to the client
const PAGE             = 1000;   // Supabase/PostgREST page size

function classifyVerdict(predictedProb, outcome) {
  const predCancel = predictedProb >= 0.5;
  const actualCancel = outcome === "cancelled" || outcome === "no_show";
  if (predCancel && actualCancel) return "hit";
  if (predCancel && !actualCancel) return "false_alarm";
  if (!predCancel && actualCancel) return "missed";
  return "stayed_ok";
}

async function loadActiveModel(sb) {
  try {
    const { data: row } = await sb
      .from("model_weights")
      .select("version, coefs")
      .eq("is_active", true)
      .maybeSingle();
    return row || null;
  } catch (err) {
    console.warn("[history] active model load failed:", err.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (!applyCors(req, res, { methods: "GET, OPTIONS" })) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const url = new URL(req.url || "/", "http://x");
  const minProb = Math.max(0, Math.min(1, parseFloat(url.searchParams.get("minProb") ?? DEFAULT_MIN_PROB)));
  const propFilter = (url.searchParams.get("prop") || "").trim();
  const verdictFilter = (url.searchParams.get("verdict") || "all").trim();
  const limit = Math.min(HARD_LIMIT, parseInt(url.searchParams.get("limit") || String(HARD_LIMIT), 10));

  try {
    const sb = getServerClient();
    const activeModel = await loadActiveModel(sb);
    const activeWeights = activeModel?.coefs || null;
    const activeVersion = activeModel?.version || "hand-tuned-v1";

    // Fetch ALL rows with outcomes (live + backfill). We score the
    // backfill rows below using the active model before filtering by
    // minProb, so the MEDIUM floor applies to retrospective predictions
    // too.
    const rows = [];
    let page = 0;
    // Oversample: for backfill rows we don't know the prob yet, so the
    // server-side gte filter would wrongly drop them. Fetch everything
    // and filter after scoring. We cap at 10× HARD_LIMIT raw rows to
    // keep Supabase happy.
    const rawCap = Math.max(HARD_LIMIT * 10, 20000);
    while (rows.length < rawCap) {
      const lo = page * PAGE;
      const hi = lo + PAGE - 1;
      const { data: batch, error } = await sb
        .from("predictions")
        .select("reservation_id, prop, snapshot_date, features, predicted_prob, score, level, model_version, outcome, outcome_final_at")
        .not("outcome", "is", null)
        .order("outcome_final_at", { ascending: false })
        .range(lo, hi);
      if (error) throw new Error(`History query failed (page ${page}): ${error.message}`);
      if (batch) rows.push(...batch);
      if (!batch || batch.length < PAGE) break;
      page++;
      if (page >= 20) break;  // 20k raw rows absolute ceiling
    }

    const rawRowsConsidered = rows.length;
    const truncated = rawRowsConsidered >= rawCap;
    if (truncated) {
      console.warn(`[history] truncated — raw rows ${rawRowsConsidered} hit rawCap=${rawCap}`);
    }

    // Score the retrospective rows and shape every row for the client.
    // We compute prob once per row — O(N) where N = rows fetched — then
    // filter afterward. This is cheap: a logistic dot product is ~30
    // ops, a GBM tree walk is ~5 per tree × few hundred trees max.
    const shaped = [];
    for (const r of rows) {
      const f = r.features || {};
      const isBackfill = r.model_version === "backfill-v1" || !r.predicted_prob;
      let predictedProb = r.predicted_prob || 0;
      let level = r.level;
      let score = r.score;
      let retrospective = false;

      if (isBackfill) {
        // Run the active model over the stored feature vector. computeRisk
        // returns { score, level, prob, override, factors } where prob is
        // 0-100; we divide to stay consistent with the 0-1 live value.
        try {
          const risk = computeRisk(f, activeWeights);
          predictedProb = (risk.prob || 0) / 100;
          level = risk.level;
          score = risk.score;
          retrospective = true;
        } catch (err) {
          // If a row has malformed features, skip it silently. Throwing
          // would take down the whole response for one bad row.
          continue;
        }
      }

      if (predictedProb < minProb) continue;

      const verdict = classifyVerdict(predictedProb, r.outcome);

      // extractRiskFactors returns the UI-friendly "why is this risky"
      // strings. Cheap (just string checks) — ~µs per call.
      let topFactors = [];
      try {
        topFactors = extractRiskFactors(f).slice(0, 3);
      } catch {
        topFactors = [];
      }

      shaped.push({
        reservation_id: r.reservation_id,
        prop: r.prop,
        guest: f.guest || "—",
        arrival: f.arrival || null,
        departure: f.departure || null,
        nights: f.nights || 0,
        rate: f.rate || "",
        channel: f.source || "",
        adr: f.adr || 0,
        total: f.total || 0,
        lead_time_days: f.leadTimeDays ?? f.daysUntil ?? null,
        country: f.nationality || "",
        persons: f.persons || 0,
        predicted_prob: predictedProb,
        score,
        level,
        model_version: retrospective ? `retro:${activeVersion}` : r.model_version,
        snapshot_date: r.snapshot_date,
        outcome: r.outcome,
        outcome_final_at: r.outcome_final_at,
        verdict,
        retrospective,
        top_factors: topFactors
      });

      if (shaped.length >= limit) break;
    }

    // Filters are applied AFTER scoring so the retrospective bucket is
    // included in the verdict counts even when the user narrows to e.g.
    // "Falsos alarmes".
    let filtered = shaped;
    if (propFilter) {
      const p = propFilter.toLowerCase();
      filtered = filtered.filter(r => (r.prop || "").toLowerCase().includes(p));
    }
    if (verdictFilter && verdictFilter !== "all") {
      filtered = filtered.filter(r => r.verdict === verdictFilter);
    }

    // Totals computed from `shaped` (pre-verdict-filter) so the chip
    // counts stay stable as the user clicks between verdicts.
    const totals = shaped.reduce(
      (acc, r) => {
        acc.all++;
        acc[r.verdict]++;
        if (r.retrospective) acc.retrospective++;
        else acc.live++;
        return acc;
      },
      { all: 0, hit: 0, false_alarm: 0, missed: 0, stayed_ok: 0, retrospective: 0, live: 0 }
    );

    return res.status(200).json({
      rows: filtered,
      totals,
      min_prob: minProb,
      active_model_version: activeVersion,
      truncated,
      raw_rows_considered: rawRowsConsidered,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[history] fatal:", err.message);
    return res.status(500).json({ error: "History fetch failed", message: err.message });
  }
}
