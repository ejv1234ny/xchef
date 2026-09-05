"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db/server";
import { getAppContext } from "@/lib/db/context";
import { runToastSync } from "@/lib/jobs/toastSync";
import { runMenuSync } from "@/lib/jobs/menuSync";

function msg(kind: "ok" | "error", text: string) {
  redirect(`/settings?${kind}=${encodeURIComponent(text)}`);
}

export async function updateLocation(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const timezone = String(formData.get("timezone") ?? "").trim() || "America/New_York";
  const name = String(formData.get("name") ?? "").trim() || ctx.location.name;
  const slug = String(formData.get("inbound_email_slug") ?? "").trim() || null;
  const guid = String(formData.get("toast_location_guid") ?? "").trim() || null;
  const { error } = await supabase
    .from("locations")
    .update({ timezone, name, inbound_email_slug: slug, toast_location_guid: guid })
    .eq("id", ctx.location.id);
  if (error) msg("error", error.message);
  revalidatePath("/settings");
  msg("ok", "Location saved");
}

/** Stores the Toast client id + secret in Vault via the security-definer RPC. The secret never comes back. */
export async function saveToastCredentials(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const clientId = String(formData.get("client_id") ?? "").trim();
  const clientSecret = String(formData.get("client_secret") ?? "").trim();
  const guid = String(formData.get("toast_location_guid") ?? "").trim();
  if (!clientId || !clientSecret || !guid) msg("error", "Client id, secret and location GUID are all required");
  const { error: lerr } = await supabase.from("locations").update({ toast_location_guid: guid }).eq("id", ctx.location.id);
  if (lerr) msg("error", lerr.message);
  const { error } = await supabase.rpc("set_toast_credentials", {
    p_location_id: ctx.location.id,
    p_client_id: clientId,
    p_client_secret: clientSecret,
  });
  if (error) msg("error", error.message);
  revalidatePath("/settings");
  msg("ok", "Toast credentials stored in Vault. First sync pulls 90 days in the background.");
}

/** Settings → Vendors: where pricing requests for this vendor go (vendors.contact_email). Empty clears it. */
export async function updateVendorContact(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  const email = String(formData.get("contact_email") ?? "").trim().toLowerCase() || null;
  if (!vendorId) msg("error", "No vendor selected");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) msg("error", `"${email}" does not look like an email address`);
  const { data, error } = await supabase.from("vendors").update({ contact_email: email }).eq("id", vendorId).eq("tenant_id", ctx.tenant.id).select("name").maybeSingle();
  if (error) msg("error", error.message);
  revalidatePath("/settings");
  revalidatePath("/prices");
  msg("ok", email ? `${data?.name ?? "Vendor"}: pricing requests go to ${email}` : `${data?.name ?? "Vendor"}: contact email cleared`);
}

export async function syncToastNow() {
  const ctx = await getAppContext();
  const { runs } = await runToastSync({ locationId: ctx.location.id, maxChunks: 1 });
  revalidatePath("/settings");
  const r = runs[0];
  if (!r) msg("error", "No Toast credentials stored yet");
  if (r.error) msg("error", r.error);
  msg("ok", `Synced ${r.orders_upserted} orders, rebuilt ${r.dates_rebuilt.length} business dates`);
}

export async function syncMenuNow() {
  const ctx = await getAppContext();
  const res = await runMenuSync({ locationId: ctx.location.id, force: true });
  revalidatePath("/settings");
  const r = res[0];
  if (!r) msg("error", "No Toast credentials stored yet");
  if (r.error) msg("error", r.error);
  msg("ok", `Menu synced: ${r.items_upserted} items (${r.modifiers_upserted} modifier options)`);
}
