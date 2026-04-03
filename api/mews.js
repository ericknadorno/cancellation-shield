export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
  const ACCESS_TOKEN = process.env.MEWS_ACCESS_TOKEN;
  const CLIENT = process.env.MEWS_CLIENT_NAME || "nexo 1.0";
  const BASE = process.env.MEWS_API_BASE || "https://api.mews-demo.com/api/connector/v1";

  if (!CLIENT_TOKEN || !ACCESS_TOKEN) {
    return res.status(500).json({ error: "Mews tokens not configured" });
  }

  const { endpoint, params } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

  const ALLOWED = [
    // Read
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
    // Write
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
      AccessToken: ACCESS_TOKEN,
      Client: CLIENT,
      ...(params || {})
    };

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
