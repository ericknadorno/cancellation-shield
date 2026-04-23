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
import { requireCronAuth } from "../lib/auth.js";
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

// Mews state → outcome label.
// NoShow is typically represented as Canceled in Mews Connector API,
// so we collapse both into "cancelled" (operationally identical from
// the revenue-protection perspective).
const STATE_TO_OUTCOME = {
  "Processed": "stayed",
  "Canceled":  "cancelled",
  "Cancelled": "cancelled"
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
  // We deliberately do NOT fetch historical payment state during backfill:
  //   1. It's the biggest SBII 504 offender (50-row batches × many accounts).
  //   2. It's a post-hoc leak — paymentStatus flips to "fail" the moment a
  //      cancellation voids the charge, which gave us the perfect-AUC false
  //      positive in prod. train_gbm.py / api/train.js both exclude `pay`
  //      from LEAK_SAFE_FEATURE_NAMES now, so nothing downstream needs it.
  // Leaving it empty here makes the backfill rows score_payment() == 45
  // (the "unknown" bucket), which is harmless because `pay` isn't learned.
  const paymentStatus = "";
  const hasCreditCard = !!res.CreditCardId;

  const createdMs = cre ? cre.getTime() : 0;
  const updatedMs = res.UpdatedUtc ? new Date(res.UpdatedUtc).getTime() : 0;
  const wasModified = Math.abs(updatedMs - createdMs) > 60000;

  const bookingHour = cre ? cre.getUTCHours() : null;
  const modificationCount = wasModified ? Math.max(1, Math.round(Math.abs(updatedMs - createdMs) / 3600000)) : 0;

  const history = ctx.priorHistoryByResId[res.Id] || { stays: 0, cancels: 0 };
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

  // 2. Pull terminal reservations.
  // We deliberately do NOT use TimeFilter here — every TimeFilter variant
  // we tried (End, Start) silently returned zero rows for some/all
  // properties even though the data exists. Instead, we paginate ALL
  // Processed/Canceled reservations and filter by CreatedUtc client-side.
  // This matches the strategy of the cancelHistoryMap call in
  // public/index.html fetchFromMews which is known to work.
  const startDateMs = new Date(startDate + "T00:00:00Z").getTime();
  const endDateMs   = new Date(endDate + "T23:59:59Z").getTime();
  const resvRaw = await fetchAllPages(
    "reservations/getAll/2023-06-06",
    {
      States: ["Processed", "Canceled"],
      Limitation: { Count: 1000 },
      Extent: { Reservations: true }
    },
    accessToken,
    "Reservations",
    50  // up to 50k reservations per property
  );

  const totalFetched = resvRaw.length;

  // Filter by CreatedUtc range
  const resvAll = resvRaw.filter(r => {
    if (!r.CreatedUtc) return false;
    const t = new Date(r.CreatedUtc).getTime();
    return !isNaN(t) && t >= startDateMs && t <= endDateMs;
  });

  if (resvAll.length === 0) {
    // Diagnostic: how many did we fetch total, what's the date range of the
    // earliest/latest, what states they have. Tells us whether Mews has any
    // history at all and whether our date filter is wrong.
    const stateCounts = {};
    let earliestCreated = null, latestCreated = null;
    for (const r of resvRaw.slice(0, 200)) {
      stateCounts[r.State] = (stateCounts[r.State] || 0) + 1;
      if (r.CreatedUtc) {
        if (!earliestCreated || r.CreatedUtc < earliestCreated) earliestCreated = r.CreatedUtc;
        if (!latestCreated   || r.CreatedUtc > latestCreated)   latestCreated   = r.CreatedUtc;
      }
    }
    return {
      status: "ok",
      property: propKey,
      property_name: enterpriseName,
      imported: 0,
      by_outcome: {},
      note: totalFetched === 0
        ? "Mews returned 0 terminal reservations for this property"
        : `Mews has ${totalFetched} terminal reservations but none created in [${startDate}, ${endDate}]`,
      debug: {
        total_fetched_from_mews: totalFetched,
        date_filter_start: startDate,
        date_filter_end: endDate,
        sample_state_counts: stateCounts,
        sample_earliest_created: earliestCreated,
        sample_latest_created: latestCreated
      }
    };
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

  // 5. (Intentionally removed) payments fetch.
  //    We used to call payments/getAll here in 50-row batches, but it was
  //    the primary cause of the Santa Barbara II 504 timeout on Vercel's
  //    Hobby tier (60s maxDuration) AND it fed the leaky `pay` feature.
  //    See mapReservation's paymentStatus comment for the full story.

  // 6. Build TEMPORAL per-reservation prior history.
  //
  // OLD (leaky): flat cancelHistoryMap counted the ENTIRE dataset per account,
  // including the current reservation's own outcome and future events.
  // A cancelled reservation counted itself as a "previous cancel", giving
  // the model a trivial discriminator (previousCancels ≥ 1 ⟹ cancelled).
  //
  // NEW: for each reservation, count only terminal reservations for the same
  // account whose CreatedUtc is STRICTLY before this one. This is the true
  // "prior history at booking time" the live model would see. A reservation
  // never sees itself or future events in the history counts.
  const byAccount = {};
  for (const r of resvAll) {
    const aid = r.AccountId || r.CustomerId;
    if (!aid) continue;
    if (!byAccount[aid]) byAccount[aid] = [];
    byAccount[aid].push(r);
  }
  // Sort each account's reservations by CreatedUtc ascending
  for (const aid of Object.keys(byAccount)) {
    byAccount[aid].sort((a, b) => {
      const ta = a.CreatedUtc || "";
      const tb = b.CreatedUtc || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
  // Walk each account in chronological order, accumulating running counts.
  // For reservation i, priorHistory = counts from reservations 0..i-1.
  const priorHistoryByResId = {};
  for (const aid of Object.keys(byAccount)) {
    let stays = 0, cancels = 0;
    for (const r of byAccount[aid]) {
      // Record priors BEFORE counting this reservation's own outcome
      priorHistoryByResId[r.Id] = { stays, cancels };
      if (r.State === "Processed") stays++;
      else if (r.State === "Canceled" || r.State === "Cancelled") cancels++;
    }
  }

  const ctx = { ratesMap, sourcesMap, customersMap, itemsMap, priorHistoryByResId };

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
    fetched_from_mews: totalFetched,
    fetched_in_date_range: resvAll.length,
    imported,
    by_outcome: byOutcome
  };
}

// ─── HTTP HANDLER ───────────────────────────────────────

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!requireCronAuth(req, res)) return;

  if (!CLIENT_TOKEN) {
    return res.status(500).json({ error: "MEWS_CLIENT_TOKEN not configured" });
  }

  const body = req.body || {};
  const property = body.property || null;
  const startDate = body.startDate || "2025-01-01";
  const endDate = body.endDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const started = Date.now();

  try {
    const results = [];

    // HQ is a portfolio account that aggregates all others — skip it.
    // It duplicates data across properties and times out due to size.
    const toProcess = property
      ? [property]
      : Object.keys(PROPERTY_TOKENS).filter(k => !!PROPERTY_TOKENS[k] && k !== "hq");

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
