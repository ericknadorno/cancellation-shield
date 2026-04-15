// nexo — cancellation risk scoring (backend)
//
// PR 1: moved from public/index.html. Algorithm byte-identical.
// PR 2: every score call upserts a row in the `predictions` table so the
//       model can later learn from real outcomes. Fail-open on DB errors.
// PR 3: refactored to import feature extraction from lib/features.js and
//       to detect learned coefs in model_weights. If a trained model exists
//       with an `intercept` key, api/score uses the pure logistic-regression
//       code path. Otherwise it falls back to the hand-tuned weighted-sum
//       sigmoid from PR 1 (cold start).

import {
  FEATURE_NAMES,
  extractFeatureVector,
  extractRiskFactors,
  applyHardOverrides
} from "../lib/features.js";
import { getServerClient } from "../lib/supabase.js";
import { applyCors } from "../lib/cors.js";

// Hand-tuned weights v1. Used when no trained model is active yet.
const DEFAULT_WEIGHTS = {
  pay: 0.15, rate: 0.14, lt: 0.13, chan: 0.12, los: 0.06, adr: 0.05,
  repeat: 0.08, card: 0.06, mod: 0.06, sea: 0.04, persons: 0.03, dow: 0.04,
  otaEmail: 0.03, nat: 0.04, natMiss: 0.03, agency: 0.03, noContact: 0.03,
  solo: 0.02, bookHour: 0.03, modCount: 0.04, adrVsAvg: 0.03, bookPayGap: 0.04,
  multiBook: 0.03, weather: 0.02,
  isRelay: 0, isGenius: 0, lateArrival: 0
};

const CANCEL_PROB_SCALE    = 0.08;
const CANCEL_PROB_MIDPOINT = 35;
const SIGMOID_MAX          = 95;
const SIGMOID_MIN          = 3;

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

// ─── HAND-TUNED PATH ───
// Unchanged from PR 1. Weighted sum of score_i values then a fixed-shape
// sigmoid with clipping. Used as fallback when no trained model exists.
function scoreHandTuned(r, W) {
  const fv = extractFeatureVector(r);
  const pay = (r.paymentStatus || r.payment || "").toLowerCase().trim();
  const rate = r.rate || "";

  let s = 0;
  s += (W.pay        || DEFAULT_WEIGHTS.pay)        * fv.pay;
  s += (W.rate       || DEFAULT_WEIGHTS.rate)       * fv.rate;
  s += (W.lt         || DEFAULT_WEIGHTS.lt)         * fv.lt;
  s += (W.chan       || DEFAULT_WEIGHTS.chan)       * fv.chan;
  s += (W.los        || DEFAULT_WEIGHTS.los)        * fv.los;
  s += (W.adr        || DEFAULT_WEIGHTS.adr)        * fv.adr;
  s += (W.repeat     || DEFAULT_WEIGHTS.repeat)     * fv.repeat;
  s += (W.card       || DEFAULT_WEIGHTS.card)       * fv.card;
  s += (W.mod        || DEFAULT_WEIGHTS.mod)        * fv.mod;
  s += (W.sea        || DEFAULT_WEIGHTS.sea)        * fv.sea;
  s += (W.persons    || DEFAULT_WEIGHTS.persons)    * fv.persons;
  s += (W.dow        || DEFAULT_WEIGHTS.dow)        * fv.dow;
  s += (W.otaEmail   || DEFAULT_WEIGHTS.otaEmail)   * fv.otaEmail;
  s += (W.nat        || DEFAULT_WEIGHTS.nat)        * fv.nat;
  s += (W.natMiss    || DEFAULT_WEIGHTS.natMiss)    * fv.natMiss;
  s += (W.agency     || DEFAULT_WEIGHTS.agency)     * fv.agency;
  s += (W.noContact  || DEFAULT_WEIGHTS.noContact)  * fv.noContact;
  s += (W.solo       || DEFAULT_WEIGHTS.solo)       * fv.solo;
  s += (W.bookHour   || DEFAULT_WEIGHTS.bookHour)   * fv.bookHour;
  s += (W.modCount   || DEFAULT_WEIGHTS.modCount)   * fv.modCount;
  s += (W.adrVsAvg   || DEFAULT_WEIGHTS.adrVsAvg)   * fv.adrVsAvg;
  s += (W.bookPayGap || DEFAULT_WEIGHTS.bookPayGap) * fv.bookPayGap;
  s += (W.multiBook  || DEFAULT_WEIGHTS.multiBook)  * fv.multiBook;
  s += (W.weather    || DEFAULT_WEIGHTS.weather)    * fv.weather;

  if (fv.isRelay)     s += 15;
  if (fv.isGenius)    s -= 3;
  if (fv.lateArrival) s += 3;

  let ov = "";
  const isNR = /nr |^nr|non-ref|early bird/i.test(rate);
  if (isNR && pay !== "charged" && pay !== "success" && pay !== "paid") {
    s += 10;
    ov = "NR:noPay";
  }

  s = Math.max(0, Math.min(Math.round(s), 100));
  let prob;
  if (s <= 0)        prob = SIGMOID_MIN;
  else if (s >= 80)  prob = SIGMOID_MAX;
  else {
    const p = SIGMOID_MAX / (1 + Math.exp(-CANCEL_PROB_SCALE * (s - CANCEL_PROB_MIDPOINT)));
    prob = Math.max(SIGMOID_MIN, Math.min(SIGMOID_MAX, Math.round(p)));
  }

  return { score: s, level: s >= 38 ? "HIGH" : s >= 18 ? "MEDIUM" : "LOW", override: ov, prob };
}

// ─── LEARNED PATH ───
// True logistic regression: logit = intercept + sum(beta_i * feature_i)
// then plain sigmoid to get p in [0,1], scaled to 0-100 for UI.
function scoreLearned(r, coefs) {
  const fv = extractFeatureVector(r);
  const rate = r.rate || "";
  const pay = (r.paymentStatus || r.payment || "").toLowerCase().trim();

  let logit = coefs.intercept || 0;
  for (const key of FEATURE_NAMES) {
    if (typeof coefs[key] === "number") {
      logit += coefs[key] * fv[key];
    }
  }

  const isNR = /nr |^nr|non-ref|early bird/i.test(rate);
  let ov = "";
  if (isNR && pay !== "charged" && pay !== "success" && pay !== "paid") {
    logit += 0.5;
    ov = "NR:noPay";
  }

  const probFrac = sigmoid(logit);
  const rawProb = Math.round(probFrac * 100);
  const prob = Math.max(SIGMOID_MIN, Math.min(SIGMOID_MAX, rawProb));
  const score = prob;
  const level = score >= 38 ? "HIGH" : score >= 18 ? "MEDIUM" : "LOW";

  return { score, level, override: ov, prob };
}

// ─── UNIFIED ENTRY POINT ───
export function computeRisk(r, activeWeights) {
  const override = applyHardOverrides(r);
  if (override) return { ...override, factors: [] };

  let risk;
  if (activeWeights && typeof activeWeights.intercept === "number") {
    risk = scoreLearned(r, activeWeights);
  } else {
    risk = scoreHandTuned(r, activeWeights || DEFAULT_WEIGHTS);
  }
  return { ...risk, factors: extractRiskFactors(r) };
}

// ─── HTTP HANDLER ───
// POST /api/score
// Body: { reservations: [...], weights?: {...}, persist?: bool }
// Response: { results, model_version, scored_at, journaled }
export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { reservations, weights, persist = true } = req.body || {};
  if (!Array.isArray(reservations)) {
    return res.status(400).json({ error: "Missing or invalid reservations array" });
  }
  if (reservations.length > 5000) {
    return res.status(413).json({ error: "Too many reservations in one call (max 5000)" });
  }

  // Load active model weights from DB. Caller can override via `weights`.
  let activeWeights = weights || null;
  let modelVersion = "hand-tuned-v1";
  if (!activeWeights) {
    try {
      const sb = getServerClient();
      const { data: row } = await sb
        .from("model_weights")
        .select("version, coefs")
        .eq("is_active", true)
        .maybeSingle();
      if (row) {
        activeWeights = row.coefs;
        modelVersion = row.version;
      }
    } catch (err) {
      console.warn("[score] model_weights load failed, using hand-tuned:", err.message);
    }
  } else {
    modelVersion = "caller-supplied";
  }

  try {
    const results = reservations.map(r => {
      const risk = computeRisk(r, activeWeights);
      return { id: r.id, ...risk };
    });

    if (persist) {
      const snapshot_date = new Date().toISOString().slice(0, 10);
      const rows = reservations.map((r, i) => {
        const out = results[i];
        return {
          reservation_id: r.id,
          prop: r.prop || null,
          snapshot_date,
          features: r,
          model_version: modelVersion,
          score: out.score,
          level: out.level,
          override: out.override || null,
          predicted_prob: out.prob / 100
        };
      });
      try {
        const sb = getServerClient();
        const { error } = await sb
          .from("predictions")
          .upsert(rows, { onConflict: "reservation_id,snapshot_date" });
        if (error) console.error("[score] journal upsert error:", error.message);
      } catch (err) {
        console.error("[score] journal exception:", err.message);
      }
    }

    return res.status(200).json({
      results,
      model_version: modelVersion,
      scored_at: new Date().toISOString(),
      journaled: persist
    });
  } catch (err) {
    console.error("[score] error:", err.message);
    return res.status(500).json({ error: "Scoring failed", message: err.message });
  }
}
