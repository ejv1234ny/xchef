"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/db/context";
import { sendQuoteRequests } from "@/lib/jobs/quoteRequest";

function msg(kind: "ok" | "error", text: string) {
  redirect(`/prices?${kind}=${encodeURIComponent(text)}`);
}

/** "Ask for pricing": one request to this vendor now (ignores the 7-day cooldown; the button is the owner's intent). */
export async function askForPricing(formData: FormData) {
  const ctx = await getAppContext();
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  if (!vendorId) msg("error", "No vendor selected");
  let results;
  try {
    results = await sendQuoteRequests({ locationId: ctx.location.id, vendorId, force: true, log: (m, meta) => console.log(JSON.stringify({ msg: m, ...meta })) });
  } catch (e) {
    return msg("error", e instanceof Error ? e.message : String(e));
  }
  revalidatePath("/prices");
  const r = results[0];
  if (!r) return msg("error", "Vendor not found");
  if (r.skipped === "no contact_email") return msg("error", `${r.vendorName} has no contact email yet — add one in Settings → Vendors.`);
  if (r.skipped?.startsWith("blocked_sender")) return msg("error", `Held, not sent: the sending domain ${r.sender.domain || "(RESEND_FROM_DOMAIN)"} is not verified in Resend yet. The request is saved as blocked_sender; add the DNS records from REPORT-3 and try again.`);
  if (r.skipped) return msg("error", `${r.vendorName}: ${r.skipped}`);
  msg("ok", `Asked ${r.vendorName} for pricing on ${r.items.length} item${r.items.length === 1 ? "" : "s"} (${r.token}). Their reply files itself.`);
}
