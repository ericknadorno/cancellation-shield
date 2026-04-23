// nexo — outcome tracker (cron: daily)
// For every prediction row with outcome IS NULL whose reservation has
// already checked out (or should have), query Mews for the CURRENT state
// and fill in the outcome column. This feeds the training loop in PR 3.
//
// Runs nightly. Idempotent — safe to call multiple times.
// Endpoint: POST /api/outcomes   (or GET for cron triggers)
//
// Mews states we map:
//   Processed → stayed      (guest completed the stay)
//   Canceled  → cancelled   (guest cancelled at some point)
//   NoShow    → no_show     (didn't cancel, didn't show up)
//   anything else → other

import { getServerClient } from "../lib/supabase.js";
import { requireCronAuth } from "../lib/auth.js";

const PROPERTY_TOKENS = {
  hq: process.env.MEWS_ACCESS_TOKEN_HQ,
  alegria: process.env.MEWS_ACCESS_TOKEN_ALEGRIA,
  sbi: process.env.MEWS_ACCESS_TOKEN_SBI,
  sbii: process.env.MEWS_ACCESS_TOKEN_SBII
};

const STATE_MAP = {
  "Processed": "stayed",
  "Canceled":  "cancelled",
  "Cancelled": "cancelled",  // just in case
  "NoShow":    "no_show",
  "No-show":   "no_show"
};

async function callMewsDirect(endpoint, params, accessToken) {
  const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
  const CLIENT = process.env.MEWS_CLIENT_NAME || "Cancellation Shield 1.0";
  const BASE = process.env.MEWS_API_BASE || "https://api.mews.com/api/connector/v1";

  const body = {
    ClientToken: CLIENT_TOKEN,
    AccessToken: accessToken,
    Client: CLIENT,
    ...params
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(BASE + "/" + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Mews ${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Given a batch of reservation IDs (from ONE property), fetch their
// current state from Mews. Returns { [reservationId]: state }.
async function fetchStatesForProperty(propKey, reservationIds) {
  const accessToken = PROPERTY_TOKENS[propKey];
  if (!accessToken) {
    console.warn(`[outcomes] No token for property ${propKey}, skipping ${reservationIds.length} rows`);
    return {};
  }

  const results = {};
  // Mews allows up to 1000 IDs per call. Batch defensively at 500.
  const BATCH = 500;
  for (let i = 0; i < reservationIds.length; i += BATCH) {
    const batch = reservationIds.slice(i, i + BATCH);
    try {
      const data = await callMewsDirect("reservations/getAll/2023-06-06", {
        ReservationIds: batch,
        Limitation: { Count: BATCH },
        Extent: { Reservations: true }
      }, accessToken);
      (data.Reservations || []).forEach(r => {
        results[r.Id] = r.State || "Unknown";
      });
    } catch (err) {
      console.error(`[outcomes] ${propKey} batch ${i} failed:`, err.message);
    }
  }
  return results;
}

// Lookup table: property name (from reservation.prop, which is the
// Mews enterprise name) → property key for token routing.
// Mirrors the logic in index.html openForSale().
function propNameToKey(name) {
  if (!name) return null;
  const lc = name.toLowerCase();
  if (lc.includes("hq") || lc.includes("portfolio")) return "hq";
  if (lc.includes("alegria")) return "alegria";
  if (lc.includes("santa") && lc.includes("ii")) return "sbii";
  if (lc.includes("santa")) return "sbi";
  return null;
}

export default async function handler(req, res) {
  // Allow GET for cron triggers (Vercel crons hit via GET by default)
  // and POST for manual runs.
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "GET or POST only" });
  }

  if (!requireCronAuth(req, res)) return;

  const startedAt = Date.now();

  try {
    const sb = (await import("../lib/supabase.js")).getServerClient();

    // Pull all predictions with no outcome yet whose reservation should
    // have finished already (arrival + nights < today - 1).
    // We over-fetch slightly and filter client-side.
    const { data: pending, error } = await sb
      .from("predictions")
      .select("id, reservation_id, prop, features, snapshot_date, outcome")
      .is("outcome", null)
      .order("snapshot_date", { ascending: false })
      .limit(5000);

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    if (!pending || pending.length === 0) {
      return res.status(200).json({
        status: "ok",
        message: "No pending predictions",
        duration_ms: Date.now() - startedAt
      });
    }

    // Filter: only reservations whose check-out date has passed (+1 day grace)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 1);

    // Unique reservation_ids grouped by property
    const byProp = {};
    const predsByReservation = {};

    for (const p of pending) {
      const dep = p.features && p.features.departure;
      if (!dep) continue;
      const depDate = new Date(dep);
      if (isNaN(depDate.getTime()) || depDate > cutoff) continue;

      const propKey = propNameToKey(p.prop || p.features.prop);
      if (!propKey) continue;

      if (!byProp[propKey]) byProp[propKey] = new Set();
      byProp[propKey].add(p.reservation_id);

      if (!predsByReservation[p.reservation_id]) predsByReservation[p.reservation_id] = [];
      predsByReservation[p.reservation_id].push(p.id);
    }

    // For each property, fetch current Mews state for those reservations
    const allStates = {};
    for (const [propKey, idSet] of Object.entries(byProp)) {
      const ids = [...idSet];
      const states = await fetchStatesForProperty(propKey, ids);
      Object.assign(allStates, states);
    }

    // Build update rows
    const updates = [];
    const now = new Date().toISOString();
    for (const [resvId, mewsState] of Object.entries(allStates)) {
      const outcome = STATE_MAP[mewsState] || "other";
      // Only mark as final if Mews considers it terminal
      const isFinal = ["Processed", "Canceled", "Cancelled", "NoShow", "No-show"].includes(mewsState);
      for (const predId of (predsByReservation[resvId] || [])) {
        updates.push({
          id: predId,
          outcome,
          outcome_checked_at: now,
          outcome_final_at: isFinal ? now : null
        });
      }
    }

    // Batch upsert
    let updated = 0;
    if (updates.length > 0) {
      const { error: upErr } = await sb
        .from("predictions")
        .upsert(updates, { onConflict: "id" });
      if (upErr) {
        throw new Error(`Supabase update failed: ${upErr.message}`);
      }
      updated = updates.length;
    }

    return res.status(200).json({
      status: "ok",
      pending_checked: pending.length,
      reservations_queried: Object.values(byProp).reduce((s, set) => s + set.size, 0),
      states_received: Object.keys(allStates).length,
      rows_updated: updated,
      duration_ms: Date.now() - startedAt
    });
  } catch (err) {
    console.error("[outcomes] fatal:", err.message);
    return res.status(500).json({
      error: "Outcome tracking failed",
      message: err.message,
      duration_ms: Date.now() - startedAt
    });
  }
}
