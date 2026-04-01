// ═══════════════════════════════════════════════════
// CANCELLATION SHIELD — Mews API Proxy
// Securely holds tokens, proxies browser requests to Mews
// ═══════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Tokens from environment variables (set in Vercel dashboard)
  const CLIENT_TOKEN = process.env.MEWS_CLIENT_TOKEN;
  const ACCESS_TOKEN = process.env.MEWS_ACCESS_TOKEN;
  const CLIENT_NAME = process.env.MEWS_CLIENT_NAME || "CancellationShield 1.0";
  const API_BASE = process.env.MEWS_API_BASE || "https://api.mews-demo.com/api/connector/v1";

  if (!CLIENT_TOKEN || !ACCESS_TOKEN) {
    return res.status(500).json({ error: "Mews tokens not configured. Set MEWS_CLIENT_TOKEN and MEWS_ACCESS_TOKEN in Vercel environment variables." });
  }

  try {
    const { endpoint, params } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

    // Whitelist of allowed endpoints (read-only)
    const ALLOWED = [
      "configuration/get",
      "enterprises/getAll",
      "services/getAll",
      "services/getAvailability",
      "resources/getAll",
      "resourceCategories/getAll",
      "resourceBlocks/getAll",
      "reservations/getAll/2023-06-06",
      "reservations/price",
      "rates/getAll",
      "rateGroups/getAll",
      "customers/getAll",
      "payments/getAll",
      "sources/getAll",
      "companionships/getAll",
      "products/getAll",
      "orderItems/getAll",
      "bills/getAll",
      "businessSegments/getAll",
      "currencies/getAll",
      "cancellationPolicies/getAll",
      "restrictions/getAll",
      "sourceAssignments/getAll",
      "reservationGroups/getAll",
      "accountingCategories/getAll",
      "exports/getAll",
      "exports/add",
      // v10.1: Write operations for Shield actions
      "serviceOrderNotes/getAll",
      "serviceOrderNotes/add",
      "serviceOrderNotes/update",
      "tasks/getAll",
      "tasks/add",
      "tasks/close",
      "messageThreads/getAll",
      "messageThreads/add",
      "messages/add",
      // v10.1: Departments for task assignment
      "departments/getAll"
    ];

    if (!ALLOWED.includes(endpoint)) {
      return res.status(403).json({ error: "Endpoint not allowed: " + endpoint });
    }

    // Build Mews API request body
    const body = {
      ClientToken: CLIENT_TOKEN,
      AccessToken: ACCESS_TOKEN,
      Client: CLIENT_NAME,
      ...(params || {})
    };

    const mewsRes = await fetch(API_BASE + "/" + endpoint, {
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
    console.error("Mews proxy error:", err);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
