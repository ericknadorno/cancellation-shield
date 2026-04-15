// nexo — Mews Connector API proxy (production-hardened)
// Stateless serverless function. Injects auth, enforces whitelist, blocks param injection.

import { applyCors } from "../lib/cors.js";

const READ_ENDPOINTS = [
  "configuration/get",
  "services/getAll",
  "services/getAvailability",
  "rates/getAll",
  "sources/getAll",
  "resources/getAll",
  "reservations/getAll/2023-06-06",
  "customers/getAll",
  "payments/getAll",
  "orderItems/getAll",
  "companionships/getAll"
];

const WRITE_ENDPOINTS = [
  "serviceOrderNotes/add",
  "tasks/add",
  "services/updateAvailability"
];

const ALL_ALLOWED = [...READ_ENDPOINTS, ...WRITE_ENDPOINTS];

// Fields that MUST NOT be overridden by client params
const PROTECTED_FIELDS = ["ClientToken", "AccessToken", "Client"];

// Max request body size (bytes) — reject oversized payloads
const MAX_BODY_SIZE = 50_000;

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // --- Auth tokens ---
  const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
  const CLIENT = process.env.MEWS_CLIENT_NAME || "Cancellation Shield 1.0";
  const BASE = process.env.MEWS_API_BASE || "https://api.mews.com/api/connector/v1";

  if (!CLIENT_TOKEN) {
    console.error("[mews] FATAL: MEWS_CLIENT_TOKEN not configured");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  // --- Parse and validate body ---
  const rawBodySize = JSON.stringify(req.body || {}).length;
  if (rawBodySize > MAX_BODY_SIZE) {
    return res.status(413).json({ error: "Request body too large" });
  }

  const { endpoint, params, property } = req.body || {};

  // --- Property-to-token mapping ---
  const PROPERTY_TOKENS = {
    hq: process.env.MEWS_ACCESS_TOKEN_HQ,
    alegria: process.env.MEWS_ACCESS_TOKEN_ALEGRIA,
    sbi: process.env.MEWS_ACCESS_TOKEN_SBI,
    sbii: process.env.MEWS_ACCESS_TOKEN_SBII
  };

  // --- Discovery endpoint ---
  if (endpoint === "properties") {
    const available = Object.entries(PROPERTY_TOKENS)
      .filter(([, token]) => !!token)
      .map(([key]) => key);
    return res.status(200).json({ properties: available });
  }

  // --- Validate endpoint ---
  if (!endpoint || typeof endpoint !== "string") {
    return res.status(400).json({ error: "Missing or invalid endpoint" });
  }
  if (!ALL_ALLOWED.includes(endpoint)) {
    console.warn(`[mews] BLOCKED endpoint: ${endpoint}`);
    return res.status(403).json({ error: "Endpoint not allowed" });
  }

  // --- Validate property key ---
  if (property && typeof property === "string") {
    if (!PROPERTY_TOKENS[property]) {
      return res.status(400).json({ error: "Unknown property key" });
    }
  }

  // --- Resolve access token ---
  const accessToken = property
    ? PROPERTY_TOKENS[property]
    : (process.env.MEWS_ACCESS_TOKEN || Object.values(PROPERTY_TOKENS).find(Boolean));

  if (!accessToken) {
    return res.status(400).json({ error: "No access token available" });
  }

  // --- Sanitize params: strip any protected fields ---
  const safeParams = { ...(params || {}) };
  for (const key of PROTECTED_FIELDS) {
    delete safeParams[key];
  }

  // --- Build Mews request body ---
  const body = {
    ClientToken: CLIENT_TOKEN,
    AccessToken: accessToken,
    Client: CLIENT,
    ...safeParams
  };

  // --- Structured logging (no secrets) ---
  const logCtx = {
    endpoint,
    property: property || "default",
    isWrite: WRITE_ENDPOINTS.includes(endpoint),
    ts: new Date().toISOString()
  };
  console.log(`[mews] ${logCtx.ts} | ${logCtx.isWrite ? "WRITE" : "READ"} ${endpoint} | prop=${logCtx.property}`);

  // --- Call Mews API with timeout ---
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const mewsRes = await fetch(BASE + "/" + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    // Handle non-JSON responses
    const contentType = mewsRes.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await mewsRes.text();
      console.error(`[mews] Non-JSON response from ${endpoint}: ${mewsRes.status} — ${text.slice(0, 200)}`);
      return res.status(502).json({ error: "Mews returned non-JSON response", status: mewsRes.status });
    }

    const data = await mewsRes.json();

    if (!mewsRes.ok) {
      // Extract safe error message — don't forward full Mews internals
      const mewsMsg = data.Message || data.message || "";
      console.error(`[mews] ERROR ${mewsRes.status} on ${endpoint}: ${mewsMsg}`);
      return res.status(mewsRes.status).json({
        error: "Mews API error",
        status: mewsRes.status,
        message: mewsMsg || ("HTTP " + mewsRes.status)
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      console.error(`[mews] TIMEOUT on ${endpoint} after 15s`);
      return res.status(504).json({ error: "Mews API timeout" });
    }
    console.error(`[mews] NETWORK ERROR on ${endpoint}: ${err.message}`);
    return res.status(502).json({ error: "Network error calling Mews" });
  }
}
