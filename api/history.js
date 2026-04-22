// nexo — prediction history endpoint.
//
// GET /api/history?minProb=0.18&prop=alegria&verdict=all&limit=500
//
// Returns every closed prediction where the live model flagged the
// reservation as MEDIUM risk or higher (predicted_prob >= 0.18) together
// with the ground-truth outcome, so staff can audit the tool reservation
// by reservation — "Reserva X teve 87% de prob, e de facto cancelou".
//
// Excludes model_version='backfill-v1' rows: those are historical Mews
// imports with a placeholder predicted_prob=0 and no real prediction was
// ever made. Including them would always count as "false negative" and
// poison the accuracy stats. The /api/model endpoint applies the same
// filter for the same reason.
//
// Response shape (kept small enough for client-side filtering/search):
// {
//   rows: [{
//     reservation_id, prop, guest, arrival, nights, rate, channel, adr,
//     lead_time_days, country, predicted_prob, level, model_version,
//     snapshot_date, outcome, outcome_final_at, verdict, top_factors
//   }, ...],
//   totals: { all, hits, false_alarms, missed, stayed_ok }
// }
//
// verdict classification (from the model's perspective, threshold 0.5):
//   hit           predicted cancel (prob >= 0.5)  AND actually cancelled
//   false_alarm   predicted cancel (prob >= 0.5)  AND actually stayed
//   missed        predicted stay   (prob <  0.5)  AND actually cancelled  *
//   stayed_ok     predicted stay   (prob <  0.5)  AND actually stayed
//
// * missed only surfaces here if level was MEDIUM (0.18-0.38) — the
//   panel filters at 0.18 so true LOW misses are invisible.

import { getServerClient } from "../lib/supabase.js";
import { applyCors } from "../lib/cors.js";
import { extractRiskFactors } from "../lib/features.js";

const DEFAULT_MIN_PROB = 0.18;   // MEDIUM floor, matches the 18% UI threshold
const HARD_LIMIT       = 2000;   // never send more than this to the client
const PAGE             = 1000;   // Supabase/PostgREST page size

function classifyVerdict(predictedProb, outcome) {
  const predCancel = predictedProb >= 0.5;
  const actualCancel = outcome === "cancelled" || outcome === "no_show";
  if (predCancel && actualCancel) return "hit";
  if (predCancel && !actualCancel) return "false_alarm";
  if (!predCancel && actualCancel) return "missed";
  return "stayed_ok";
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

    // Paginate — PostgREST caps each response at ~1000 rows regardless
    // of .limit(). Same pattern used in api/train.js after PR #21.
    const rows = [];
    let page = 0;
    while (rows.length < limit) {
      const lo = page * PAGE;
      const hi = Math.min(lo + PAGE - 1, limit - 1);
      const { data: batch, error } = await sb
        .from("predictions")
        .select("reservation_id, prop, snapshot_date, features, predicted_prob, score, level, model_version, outcome, outcome_final_at")
        .not("outcome", "is", null)
        .neq("model_version", "backfill-v1")
        .gte("predicted_prob", minProb)
        .order("outcome_final_at", { ascending: false })
        .range(lo, hi);
      if (error) throw new Error(`History query failed (page ${page}): ${error.message}`);
      if (batch) rows.push(...batch);
      if (!batch || batch.length < PAGE) break;
      page++;
      if (page >= 10) break;  // 10k safety cap (HARD_LIMIT already caps earlier)
    }

    // Shape for client. Keeps only the fields the panel actually renders
    // — features column is too large to ship every key.
    const shaped = rows.map(r => {
      const f = r.features || {};
      const verdict = classifyVerdict(r.predicted_prob, r.outcome);
      // extractRiskFactors returns the UI-friendly "why the score is
      // high" list. Cheap enough to compute per row since it's just
      // string checks — no heavy math.
      let topFactors = [];
      try {
        topFactors = extractRiskFactors(f).slice(0, 3);
      } catch {
        topFactors = [];
      }
      return {
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
        predicted_prob: r.predicted_prob,
        score: r.score,
        level: r.level,
        model_version: r.model_version,
        snapshot_date: r.snapshot_date,
        outcome: r.outcome,
        outcome_final_at: r.outcome_final_at,
        verdict,
        top_factors: topFactors
      };
    });

    // Optional server-side filtering. Client can also filter locally
    // but passing through narrows the payload when the user knows what
    // they want.
    let filtered = shaped;
    if (propFilter) {
      const p = propFilter.toLowerCase();
      filtered = filtered.filter(r => (r.prop || "").toLowerCase().includes(p));
    }
    if (verdictFilter && verdictFilter !== "all") {
      filtered = filtered.filter(r => r.verdict === verdictFilter);
    }

    // Totals — computed from `shaped` (pre-filter) so the sidebar
    // counts are stable as the user flips between verdict chips.
    const totals = shaped.reduce(
      (acc, r) => {
        acc.all++;
        acc[r.verdict]++;
        return acc;
      },
      { all: 0, hit: 0, false_alarm: 0, missed: 0, stayed_ok: 0 }
    );

    return res.status(200).json({
      rows: filtered,
      totals,
      min_prob: minProb,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[history] fatal:", err.message);
    return res.status(500).json({ error: "History fetch failed", message: err.message });
  }
}
