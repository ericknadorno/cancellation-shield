// Mews webhook receiver — receives ServiceOrderUpdated events.
// Currently logs and acknowledges. Future: trigger dashboard refresh.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const event = req.body || {};
    const type = event.Type || event.Events?.[0]?.Type || "unknown";
    const enterprise = event.EnterpriseId || "unknown";

    console.log("[webhook]", new Date().toISOString(), type, enterprise);

    return res.status(200).json({ status: "received", type, enterprise });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({ status: "error", message: err.message });
  }
}
