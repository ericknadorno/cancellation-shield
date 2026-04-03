// nexo — Mews webhook receiver (production-hardened)
// Receives ServiceOrderUpdated events from Mews.
// Currently: logs and acknowledges. Future: trigger dashboard refresh.

export default async function handler(req, res) {
  // Mews sends POST only
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    return res.status(200).end();
  }
  if (req.method !== "POST") return res.status(405).end();

  try {
    const event = req.body || {};

    // Basic structure validation — Mews webhooks have known shapes
    if (!event || (typeof event !== "object")) {
      console.warn("[webhook] Invalid payload received");
      return res.status(200).json({ status: "ignored" });
    }

    const type = event.Type || event.Events?.[0]?.Type || "unknown";
    const enterprise = event.EnterpriseId || "unknown";

    // Log for observability — no sensitive data
    console.log(`[webhook] ${new Date().toISOString()} | type=${type} | enterprise=${enterprise}`);

    // Always return 200 to Mews — otherwise it retries indefinitely
    return res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("[webhook] Error processing event:", err.message);
    // Still return 200 to prevent Mews retry storms
    return res.status(200).json({ status: "error" });
  }
}
