// nexo — historical Mews backfill.
//
// Bootstraps the training data by pulling every terminal reservation
// (Processed / Canceled / NoShow) from the Mews Connector API since a
// given start date, mapping each to the same feature vector the live
// model uses, and upserting them into `predictions` with outcomes
// already filled. Trains the model on the result.
//
// Instead of waiting 30-60 days for real predictions to accumulate
// outcomes organically, this lets the model learn from all the
// historical data the user already has in Mews.
//
// POST /api/backfill
// Body: { property?: "hq"|"alegria"|"sbi"|"sbii", startDate?: "2025-01-01" }
// Response: { status, property, imported, by_outcome, training_ready }
//
// Guarded by CRON_SECRET if set. Otherwise anyone with the URL can
// trigger it — fine for internal use, tighten later if needed.

import { getServerClient } from "../lib/supabase.js";
import { applyCors } from "../lib/cors.js";
import { extractFeatureVector } from "../lib/features.js";

const PROPERTY_TOKENS = {
  hq: process.env.MEWS_ACCESS_TOKEN_HQ,
  alegria: process.env.MEWS_ACCESS_TOKEN_ALEGRIA,
  sbi: process.env.MEWS_ACCESS_TOKEN_SBI,
  sbii: process.env.MEWS_ACCESS_TOKEN_SBII
};

const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
const CLIENT_NAME = process.env.MEWS_CLIENT_NAME || "Cancellation Shield 1.0";
const BASE = process.env.MEWS_API_BASE || "https://api.mews.com/api/connector/v1";

const PROPERTY_NAMES = {
  hq: "HQ Portfolio",
  alegria: "Alegria",
  sbi: "Santa Barbara I",
  sbii: "Santa Barbara II"
};

// Mews state → outcome label
const STATE_TO_OUTCOME = {
  "Processed": "stayed",
  "Canceled":  "cancelled",
  "Cancelled": "cancelled",
  "NoShow":    "no_show",
  "No-show":   "no_show"
};

// ─── Mews fetch ─────────────────────────────────────────

async function callMews(endpoint, params, accessToken, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + "/" + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ClientToken: CLIENT_TOKEN,
        AccessToken: accessToken,
        Client: CLIENT_NAME,
        ...params
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Mews ${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchAllPages(endpoint, params, accessToken, dataKey, maxPages = 30) {
  let all = [];
  let cursor = null;
  let page = 0;
  do {
    const p = { ...params, Limitation: { ...params.Limitation, Cursor: cursor } };
    const r = await callMews(endpoint, p, accessToken);
    const items = r[dataKey] || [];
    all = all.concat(items);
    cursor = r.Cursor || null;
    page++;
    if (page >= maxPages) break;
  } while (cursor);
  return all;
}

// Reconstruct the same reservation shape that mapMewsReservation
// produces client-side, so extractFeatureVector(r) yields identical
// feature values.
function mapReservation(res, ctx, enterpriseName) {
  const arr = res.StartUtc ? new Date(res.StartUtc) : null;
  const dep = res.EndUtc ? new Date(res.EndUtc) : null;
  const cre = res.CreatedUtc ? new Date(res.CreatedUtc) : null;
  const nights = arr && dep ? Math.round((dep - arr) / 864e5) : 0;
  const lt = arr && cre ? Math.round((arr - cre) / 864e5) : 0;

  // For backfill, "now" for daysUntil is the creation date (when the
  // prediction WOULD have been made). daysUntil is used for lead-time
  // scoring which is logically the same as leadTimeDays here.
  const du = lt;

  const rateName   = ctx.ratesMap[res.RateId] || "";
  const sourceName = ctx.sourcesMap[res.SourceId] || res.Origin || "";
  const customer   = ctx.customersMap[res.AccountId] || ctx.customersMap[res.CustomerId] || {};
  const email      = customer.Email || "";
  const nationality = customer.NationalityCode || "";
  const hasOtaEmail = customer.HasOtaEmail || false;

  const pc = res.PersonCounts;
  const personCount = pc ? pc.reduce((s, p) => s + (p.Count || 0), 0) : 1;

  const itemsTotal = ctx.itemsMap[res.Id] || 0;
  const totalAmount = itemsTotal > 0 ? itemsTotal : (res.TotalAmount?.Value || 0);
  const adr = nights > 0 ? Math.round(totalAmount / nights) : 0;

  const notes = res.Notes || "";
  const paymentStatus = ctx.paymentsMap[res.AccountId] || "";
  const hasCreditCard = !!res.CreditCardId;

  const createdMs = cre ? cre.getTime() : 0;
  const updatedMs = res.UpdatedUtc ? new Date(res.UpdatedUtc).getTime() : 0;
  const wasModified = Math.abs(updatedMs - createdMs) > 60000;

  const bookingHour = cre ? cre.getUTCHours() : null;
  const modificationCount = wasModified ? Math.max(1, Math.round(Math.abs(updatedMs - createdMs) / 3600000)) : 0;

  const history = ctx.cancelHistoryMap[res.AccountId || res.CustomerId] || { stays: 0, cancels: 0 };
  const hasChildren = false;  // not reliably extractable from historical data
  const hasTravelAgency = !!res.TravelAgencyId;

  return {
    id: res.Id,
    guest: ((customer.FirstName || "") + " " + (customer.LastName || "")).trim(),
    prop: enterpriseName,
    room: "",
    roomType: "",
    status: res.State || "",
    arrival: arr ? arr.toISOString().split("T")[0] : "",
    departure: dep ? dep.toISOString().split("T")[0] : "",
    nights,
    daysUntil: du,
    leadTimeDays: lt,
    rate: rateName,
    adr,
    total: Math.round(totalAmount),
    source: sourceName,
    payment: (res.PaymentState || "").toLowerCase(),
    email,
    phone: customer.Phone || "",
    persons: personCount,
    nationality,
    hasNoContact: !email && !customer.Phone,
    isSolo: personCount === 1,
    arrMonth: arr ? arr.getMonth() + 1 : null,
    isRelay: email.includes("@guest.booking.com"),
    isGenius: notes.includes("booker_is_genius"),
    hasPet: /bringing your pet.*(Sim|Yes)/i.test(notes),
    hasParking: false,
    hasVoucher: !!res.VoucherId,
    guestCheckedIn: notes.includes("Guest Check-in info") || notes.includes("online check-in") || notes.includes("pre-check-in"),
    cardType: "",
    classifications: "",
    lateArrival: /between 2[0-3]|between 0[0-4]/i.test(notes),
    travelAgency: res.TravelAgencyId || "",
    hasOtaEmail,
    paymentStatus,
    hasCreditCard,
    wasModified,
    previousStays: history.stays,
    previousCancels: history.cancels,
    hasChildren,
    hasTravelAgency,
    bookingHour,
    modificationCount,
    propAvgAdr: 0,  // not available in historical backfill
    bookPayGapDays: null,
    guestActiveBookings: 1,
    weatherCode: null
  };
}

// ─── Import for ONE property ─────────────────────────────

async function importProperty(propKey, startDate, endDate) {
  const accessToken = PROPERTY_TOKENS[propKey];
  if (!accessToken) {
    return { status: "skipped", reason: "no_token", property: propKey };
  }

  const enterpriseName = PROPERTY_NAMES[propKey] || propKey;

  // 1. Pull supporting maps (rates, sources, customers batch, etc.)
  const ratesRes = await fetchAllPages(
    "rates/getAll",
    { Limitation: { Count: 1000 } },
    accessToken,
    "Rates",
    20
  );
  const ratesMap = {};
  ratesRes.forEach(r => { ratesMap[r.Id] = r.Name || ""; });

  const sourcesRes = await fetchAllPages(
    "sources/getAll",
    { Limitation: { Count: 1000 } },
    accessToken,
    "Sources",
    10
  );
  const sourcesMap = {};
  sourcesRes.forEach(s => { sourcesMap[s.Id] = s.Name || ""; });

  // 2. Pull terminal reservations in the date range.
  // TimeFilter: "End" → filter by departure date (we want finished stays)
  const resvAll = await fetchAllPages(
    "reservations/getAll/2023-06-06",
    {
      States: ["Processed", "Canceled", "NoShow"],
      TimeFilter: "End",
      StartUtc: startDate + "T00:00:00Z",
      EndUtc: endDate + "T23:59:59Z",
      Limitation: { Count: 200 },
      Extent: { Reservations: true }
    },
    accessToken,
    "Reservations",
    100  // allow up to 20k reservations per property
  );

  if (resvAll.length === 0) {
    return { status: "ok", property: propKey, imported: 0, by_outcome: {}, note: "no historical reservations in range" };
  }

  // 3. Pull related customers in batches (needed for nationality, email)
  const accountIds = [...new Set(resvAll.map(r => r.AccountId || r.CustomerId).filter(Boolean))];
  const customersMap = {};
  for (let i = 0; i < accountIds.length; i += 200) {
    const batch = accountIds.slice(i, i + 200);
    try {
      const r = await callMews(
        "customers/getAll",
        { CustomerIds: batch, Limitation: { Count: 200 }, Extent: { Customers: true, Documents: false, Addresses: false } },
        accessToken
      );
      (r.Customers || []).forEach(c => { customersMap[c.Id] = c; });
    } catch (err) {
      console.warn(`[backfill] ${propKey}: customer batch ${i} failed:`, err.message);
    }
  }

  // 4. Pull order items (revenue totals for ADR)
  const itemsMap = {};
  const resIds = resvAll.map(r => r.Id);
  for (let i = 0; i < resIds.length; i += 50) {
    const batch = resIds.slice(i, i + 50);
    try {
      const r = await callMews(
        "orderItems/getAll",
        { ServiceOrderIds: batch, Limitation: { Count: 1000 } },
        accessToken
      );
      (r.OrderItems || []).forEach(it => {
        const rid = it.ServiceOrderId;
        itemsMap[rid] = (itemsMap[rid] || 0) + (it.Amount?.GrossValue || 0);
      });
    } catch (err) {
      console.warn(`[backfill] ${propKey}: items batch ${i} failed:`, err.message);
    }
  }

  // 5. Pull payments
  const paymentsMap = {};
  for (let i = 0; i < accountIds.length; i += 50) {
    const batch = accountIds.slice(i, i + 50);
    try {
      const r = await callMews(
        "payments/getAll",
        { AccountIds: batch, Limitation: { Count: 500 } },
        accessToken
      );
      (r.Payments || []).forEach(p => {
        const aid = p.AccountId;
        const state = (p.State || "").toLowerCase();
        if (state === "charged" || state === "paid") paymentsMap[aid] = "charged";
        else if (!paymentsMap[aid]) paymentsMap[aid] = state;
      });
    } catch (err) {
      console.warn(`[backfill] ${propKey}: payments batch ${i} failed:`, err.message);
    }
  }

  // 6. Build per-account history from the same dataset (fast: we already
  // have all terminal reservations in memory)
  const cancelHistoryMap = {};
  for (const r of resvAll) {
    const aid = r.AccountId || r.CustomerId;
    if (!aid) continue;
    if (!cancelHistoryMap[aid]) cancelHistoryMap[aid] = { stays: 0, cancels: 0 };
    if (r.State === "Processed") cancelHistoryMap[aid].stays++;
    if (r.State === "Canceled" || r.State === "Cancelled") cancelHistoryMap[aid].cancels++;
  }

  const ctx = { ratesMap, sourcesMap, customersMap, itemsMap, paymentsMap, cancelHistoryMap };

  // 7. Map each reservation, build upsert rows
  const rows = [];
  const byOutcome = { cancelled: 0, stayed: 0, no_show: 0, other: 0 };
  const now = new Date().toISOString();

  for (const res of resvAll) {
    const mapped = mapReservation(res, ctx, enterpriseName);
    // Use the reservation's creation date as snapshot_date — represents
    // "what the model WOULD have predicted on the day the booking happened"
    const snapshotDate = res.CreatedUtc
      ? new Date(res.CreatedUtc).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const outcome = STATE_TO_OUTCOME[res.State] || "other";
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

    // We skip building feature vector + prob here — the model_version
    // "backfill-v1" is a marker, not a real prediction. The score,
    // level, predicted_prob are placeholders (training only reads
    // features + outcome). Use score=0 so the PR #2 schema's NOT NULL
    // constraint is satisfied without misleading the UI.
    rows.push({
      reservation_id: mapped.id,
      prop: enterpriseName,
      snapshot_date: snapshotDate,
      features: mapped,
      model_version: "backfill-v1",
      score: 0,
      level: "LOW",
      override: null,
      predicted_prob: 0,
      outcome,
      outcome_checked_at: now,
      outcome_final_at: now
    });
  }

  // 8. Batch upsert to predictions
  const sb = getServerClient();
  const BATCH = 500;
  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("predictions")
      .upsert(batch, { onConflict: "reservation_id,snapshot_date" });
    if (error) {
      console.error(`[backfill] ${propKey}: upsert batch ${i} failed:`, error.message);
      continue;
    }
    imported += batch.length;
  }

  return {
    status: "ok",
    property: propKey,
    property_name: enterpriseName,
    fetched: resvAll.length,
    imported,
    by_outcome: byOutcome
  };
}

// ─── HTTP HANDLER ───────────────────────────────────────

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!CLIENT_TOKEN) {
    return res.status(500).json({ error: "MEWS_CLIENT_TOKEN not configured" });
  }

  // Optional auth for the backfill endpoint
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers.authorization || "";
    if (header !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const body = req.body || {};
  const property = body.property || null;
  const startDate = body.startDate || "2025-01-01";
  const endDate = body.endDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const started = Date.now();

  try {
    const results = [];

    const toProcess = property
      ? [property]
      : Object.keys(PROPERTY_TOKENS).filter(k => !!PROPERTY_TOKENS[k]);

    for (const propKey of toProcess) {
      try {
        const r = await importProperty(propKey, startDate, endDate);
        results.push(r);
      } catch (err) {
        results.push({ status: "error", property: propKey, message: err.message });
      }
    }

    const total = results.reduce((s, r) => s + (r.imported || 0), 0);
    return res.status(200).json({
      status: "ok",
      duration_ms: Date.now() - started,
      start_date: startDate,
      end_date: endDate,
      properties: results,
      total_imported: total,
      hint: total > 100
        ? `Run POST /api/train next to fit the model on ${total} historical outcomes`
        : "Not enough data yet — try a wider date range or check Mews tokens"
    });
  } catch (err) {
    console.error("[backfill] fatal:", err.message);
    return res.status(500).json({
      error: "Backfill failed",
      message: err.message,
      duration_ms: Date.now() - started
    });
  }
}
