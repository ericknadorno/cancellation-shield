// Server-side Supabase client factory.
// Uses the SERVICE key (bypasses RLS) because all calls originate from
// trusted serverless functions — never from the browser.

import { createClient } from "@supabase/supabase-js";

let cached = null;

export function getServerClient() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Supabase not configured: SUPABASE_URL and SUPABASE_SECRET_KEY env vars required");
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return cached;
}

// Helper: silent fail-open for non-critical writes.
// The scoring endpoint should never fail just because the journal write failed.
export async function safeInsert(table, rows) {
  try {
    const sb = getServerClient();
    const { error } = await sb.from(table).upsert(rows, { ignoreDuplicates: false });
    if (error) {
      console.error(`[supabase] ${table} upsert error:`, error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error(`[supabase] ${table} upsert exception:`, err.message);
    return { ok: false, error: err.message };
  }
}
