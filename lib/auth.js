// nexo — shared cron/admin auth gate.
//
// Deny-by-default in production: if CRON_SECRET isn't configured, the
// endpoint returns 500 rather than becoming publicly callable. In dev
// (non-production Vercel environments) the gate is open so local testing
// works without ceremony.
//
// Usage:
//   import { requireCronAuth } from "../lib/auth.js";
//   if (!requireCronAuth(req, res)) return;

export function requireCronAuth(req, res) {
  const isProd = process.env.VERCEL_ENV === "production";
  const secret = (process.env.CRON_SECRET || "").trim();

  if (isProd && !secret) {
    console.error("[auth] FATAL: CRON_SECRET unset in production");
    res.status(500).json({ error: "Server misconfiguration: CRON_SECRET unset in production" });
    return false;
  }

  if (secret) {
    const header = req.headers.authorization || "";
    if (header !== `Bearer ${secret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
  }
  return true;
}
