// ═══════════════════════════════════════════════════
// CANCELLATION SHIELD v11 — Mews API Proxy + Weather
// Securely holds tokens, proxies browser requests to Mews
// Added: OpenWeatherMap proxy route for weather signals
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

  // OpenWeatherMap (free tier: 1M calls/month)
  const OWM_KEY = process.env.OPENWEATHER_API_KEY || "";

  try {
    const { endpoint, params } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

    // ─── V11: Weather route ───
    if (endpoint === "weather/forecast") {
      if (!OWM_KEY) {
        return res.status(200).json({ forecasts: {}, message: "No OpenWeatherMap API key configured" });
      }
      // Lisbon coordinates (all 3 properties are in Lisbon)
      const lat = params?.lat || 38.7223;
      const lon = params?.lon || -9.1393;
      const owmUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OWM_KEY}&units=metric&cnt=40`;

      try {
        const owmRes = await fetch(owmUrl);
        const owmData = await owmRes.json();

        if (!owmRes.ok) {
          return res.status(200).json({ forecasts: {}, message: "Weather API error: " + (owmData.message || owmRes.status) });
        }

        // Group by date, take the most severe weather per day
        const byDate = {};
        (owmData.list || []).forEach(item => {
          const date = item.dt_txt?.split(" ")[0];
          if (!date) return;
          const code = item.weather?.[0]?.id || 800;
          const desc = item.weather?.[0]?.description || "";
          const temp = item.main?.temp || 0;
          // Keep worst weather per day (lower codes = worse weather)
          if (!byDate[date] || code < byDate[date].code) {
            byDate[date] = { code, desc, temp: Math.round(temp) };
          }
        });

        return res.status(200).json({ forecasts: byDate });
      } catch (weatherErr) {
        return res.status(200).json({ forecasts: {}, message: "Weather fetch failed: " + weatherErr.message });
      }
    }

    // ─── Mews API proxy ───
    if (!CLIENT_TOKEN || !ACCESS_TOKEN) {
      return res.status(500).json({ error: "Mews tokens not configured. Set MEWS_CLIENT_TOKEN and MEWS_ACCESS_TOKEN in Vercel environment variables." });
    }

    // Whitelist of allowed endpoints (read-only + write actions)
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
      // Write operations for Shield actions
      "serviceOrderNotes/getAll",
      "serviceOrderNotes/add",
      "serviceOrderNotes/update",
      "tasks/getAll",
      "tasks/add",
      "tasks/close",
      "messageThreads/getAll",
      "messageThreads/add",
      "messages/add",
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
    console.error("Shield proxy error:", err);
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
