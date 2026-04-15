// nexo — shared CORS + origin verification.
//
// Three classes of caller are allowed:
//   1. Same-origin requests (browsers often omit the Origin header entirely
//      for same-origin POST — we must not reject these).
//   2. Exact matches against the comma-separated ALLOWED_ORIGINS env var.
//   3. Wildcard patterns in ALLOWED_ORIGINS (e.g. `https://*.vercel.app`)
//      — lets PR preview deployments work without reconfiguring env vars.
//
// Everything else → 403 with the actual Origin echoed back so debugging is
// possible without reading serverless logs.

function parseAllowed() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function wildcardMatch(origin, pattern) {
  // Supports patterns like https://*.vercel.app or https://foo-*.example.com
  // Only the literal `*` wildcard is recognized — no regex, no brace expansion.
  if (!pattern.includes("*")) return origin === pattern;
  const esc = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")  // escape regex specials
    .replace(/\*/g, "[^.]*");                // * matches any chars except dot
  return new RegExp("^" + esc + "$").test(origin);
}

function isOriginAllowed(origin, allowedList) {
  if (!origin) return true;  // same-origin requests without Origin header
  for (const pattern of allowedList) {
    if (wildcardMatch(origin, pattern)) return true;
  }
  return false;
}

/**
 * Run the CORS preflight/check. Sets all necessary headers on res.
 * Returns `true` if the caller should continue (request is allowed).
 * Returns `false` if the caller should stop (headers + status already set).
 *
 * Usage:
 *   if (!applyCors(req, res, { methods: "POST, OPTIONS" })) return;
 */
export function applyCors(req, res, opts = {}) {
  const origin = req.headers.origin || "";
  const allowed = parseAllowed();
  const isProd = process.env.VERCEL_ENV === "production";

  if (isProd && allowed.length === 0) {
    console.error("[cors] FATAL: ALLOWED_ORIGINS not configured in production");
    res.status(500).json({ error: "Server misconfiguration: CORS unset" });
    return false;
  }

  if (allowed.length > 0) {
    if (!isOriginAllowed(origin, allowed)) {
      console.warn(`[cors] blocked: origin=${origin || "(empty)"} allowed=${allowed.join("|")}`);
      res.status(403).json({
        error: "Origin not allowed",
        received_origin: origin || "(empty)",
        hint: "Check ALLOWED_ORIGINS env var matches exactly. You can use wildcards like https://*.vercel.app"
      });
      return false;
    }
    // Echo the caller's origin (or the first allowed entry if empty)
    res.setHeader("Access-Control-Allow-Origin", origin || allowed[0].replace("*", ""));
    res.setHeader("Vary", "Origin");
  } else {
    // Dev / no ALLOWED_ORIGINS set → permissive
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }

  res.setHeader("Access-Control-Allow-Methods", opts.methods || "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", opts.headers || "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return false;  // stop — preflight handled
  }

  return true;  // continue
}
