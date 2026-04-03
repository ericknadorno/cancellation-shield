export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
  const CLIENT = process.env.MEWS_CLIENT_NAME || "nexo 1.0";
  const BASE = process.env.MEWS_API_BASE || "https://api.mews.com/api/connector/v1";

  if (!CLIENT_TOKEN) {
    return res.status(500).json({ error: "MEWS_CLIENT_TOKEN not configured" });
  }

  const { endpoint, params, property } = req.body || {};

  // Property-to-token mapping
  const PROPERTY_TOKENS = {
    hq: process.env.MEWS_ACCESS_TOKEN_HQ,
    alegria: process.env.MEWS_ACCESS_TOKEN_ALEGRIA,
    sbi: process.env.MEWS_ACCESS_TOKEN_SBI,
    sbii: process.env.MEWS_ACCESS_TOKEN_SBII
  };

  // Discovery: return which properties are configured
  if (endpoint === "properties") {
    const available = Object.entries(PROPERTY_TOKENS)
      .filter(([, token]) => !!token)
      .map(([key]) => key);
    return res.status(200).json({ properties: available });
  }

  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

  // Resolve access token: property-specific or legacy fallback
  const accessToken = property
    ? PROPERTY_TOKENS[property]
    : (process.env.MEWS_ACCESS_TOKEN || Object.values(PROPERTY_TOKENS).find(Boolean));

  if (!accessToken) {
    return res.status(400).json({ error: "No access token for property: " + (property || "default") });
  }

  const ALLOWED = [
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
    "companionships/getAll",
    "serviceOrderNotes/add",
    "tasks/add",
    "services/updateAvailability"
  ];

  if (!ALLOWED.includes(endpoint)) {
    return res.status(403).json({ error: "Endpoint not allowed: " + endpoint });
  }

  try {
    const body = {
      ClientToken: CLIENT_TOKEN,
      AccessToken: accessToken,
      Client: CLIENT,
      ...(params || {})
    };

    console.log(`[mews] ${endpoint} → ${BASE} | prop=${property||"default"} | token=${accessToken?.slice(0,8)}...`);
    const mewsRes = await fetch(BASE + "/" + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await mewsRes.json();

    if (!mewsRes.ok) {
      return res.status(mewsRes.status).json({
        error: "Mews API error",
        status: mewsRes.status,
        details: data
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
