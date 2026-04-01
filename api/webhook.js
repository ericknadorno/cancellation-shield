// Cancellation Shield — Mews Webhook Receiver
// Receives ServiceOrderUpdated events from Mews
// For now: logs events. Future: triggers re-fetch.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const event = req.body || {};
    const eventType = event.Type || event.Events?.[0]?.Type || "unknown";
    const enterpriseId = event.EnterpriseId || "unknown";

    console.log("[Webhook]", new Date().toISOString(), "type:", eventType, "enterprise:", enterpriseId);

    // Mews expects a 200 response to acknowledge receipt
    return res.status(200).json({
      status: "received",
      type: eventType,
      enterprise: enterpriseId,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({ status: "error", message: err.message });
  }
}
