import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "./types";

export type ServiceClient = SupabaseClient<Database>;

let cached: ServiceClient | undefined;

/**
 * Service-role client. Bypasses RLS. Server-only by construction (the key is
 * not NEXT_PUBLIC_*). Used by cron routes, the inbound webhook, CLI scripts and
 * the first-login bootstrap.
 */
export function createServiceSupabase(): ServiceClient {
  if (cached) return cached;
  cached = createClient<Database>(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
