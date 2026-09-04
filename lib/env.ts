/**
 * Lazy environment access. Nothing here runs at import time, so `next build`
 * succeeds without secrets and a missing secret fails loudly only at the call
 * site that needs it.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  cronSecret: () => required("CRON_SECRET"),
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),
  openaiApiKey: () => required("OPENAI_API_KEY"),
  postmarkInboundSecret: () => required("POSTMARK_INBOUND_SECRET"),
  toastApiHost: () => process.env.TOAST_API_HOST ?? "https://ws-api.toasttab.com",
  appUrl: () => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  has: (name: string) => Boolean(process.env[name]),
};
