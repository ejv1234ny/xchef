import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createServerSupabase } from "./server";
import { createServiceSupabase } from "./service";
import type { Tables } from "./types";

export type AppContext = {
  userId: string;
  email: string | null;
  tenant: Tables<"tenants">;
  location: Tables<"locations">;
};

const DEFAULT_TENANT_NAME = "Mad Moose";
const DEFAULT_LOCATION_NAME = "Mad Moose Bar & Grill";
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_SLUG = "madmoose";

/**
 * First login: a user with no membership cannot see anything through RLS, so
 * the bootstrap runs with the service role. One tenant, one location, owner
 * membership. Idempotent: if a tenant already exists and the user is not a
 * member, the user is attached to the first tenant (single-restaurant build).
 */
async function bootstrap(userId: string) {
  const svc = createServiceSupabase();
  const { data: existing } = await svc.from("tenants").select("id").order("created_at").limit(1);
  let tenantId = existing?.[0]?.id;
  if (!tenantId) {
    const { data: t, error } = await svc
      .from("tenants")
      .insert({ name: DEFAULT_TENANT_NAME })
      .select("id")
      .single();
    if (error) throw error;
    tenantId = t.id;
    const { error: lerr } = await svc.from("locations").insert({
      tenant_id: tenantId,
      name: DEFAULT_LOCATION_NAME,
      timezone: DEFAULT_TIMEZONE,
      toast_location_guid: process.env.TOAST_RESTAURANT_GUIDS?.split(",")[0]?.trim() || null,
      inbound_email_slug: DEFAULT_SLUG,
    });
    if (lerr) throw lerr;
  }
  const { error: merr } = await svc
    .from("memberships")
    .upsert({ user_id: userId, tenant_id: tenantId, role: "owner" }, { onConflict: "user_id,tenant_id" });
  if (merr) throw merr;
}

/** Signed-in user + their tenant + the single location. Redirects to /login when signed out. */
export const getAppContext = cache(async (): Promise<AppContext> => {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let { data: tenants } = await supabase.from("tenants").select("*").order("created_at").limit(1);
  if (!tenants || tenants.length === 0) {
    await bootstrap(user.id);
    ({ data: tenants } = await supabase.from("tenants").select("*").order("created_at").limit(1));
  }
  const tenant = tenants?.[0];
  if (!tenant) throw new Error("Tenant bootstrap failed");

  const { data: locations } = await supabase
    .from("locations")
    .select("*")
    .eq("tenant_id", tenant.id)
    .order("created_at")
    .limit(1);
  const location = locations?.[0];
  if (!location) throw new Error("No location for tenant");

  return { userId: user.id, email: user.email ?? null, tenant, location };
});
