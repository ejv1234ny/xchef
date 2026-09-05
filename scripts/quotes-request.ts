/**
 * pnpm quotes:request --dry                      compose one email per vendor with a contact; print, send nothing
 * pnpm quotes:request                            send them (Resend), one quote_requests row each; 7-day cooldown per vendor
 * pnpm quotes:request --vendor "802 Spirits"     one vendor (name, case-insensitive substring, or id); ignores the cooldown
 * pnpm quotes:request --shock [--dry]            only vendors of ingredients with a ≥ 10% 30-day price change
 * pnpm quotes:request --ingest <document-id>     write vendor_quotes from an already-parsed-and-mapped quote document
 *                                                (upload-channel price lists; email replies ingest automatically)
 * Optional: --location <id> (default: the first location). Never prints a secret.
 */
import "./_env";
import { arg, hasFlag, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { requestsForPriceShock, sendQuoteRequests, type QuoteRequestResult } from "@/lib/jobs/quoteRequest";
import { finalizeQuoteDocument } from "@/lib/jobs/quoteIngest";

async function main() {
  const svc = createServiceSupabase();
  const dry = hasFlag("dry");

  const ingestId = arg("ingest");
  if (ingestId) {
    const results = await finalizeQuoteDocument(svc, ingestId, { log });
    console.table(results.map((r) => ({ document: r.documentId.slice(0, 8), status: r.status, quotes: r.quotes, without_cost: r.withoutCost, skipped_lines: r.skippedLines, request: r.quoteRequestId?.slice(0, 8) ?? null })));
    return;
  }

  let locationId = arg("location");
  if (!locationId) {
    const { data } = await svc.from("locations").select("id, name").order("created_at").limit(1);
    if (!data?.[0]) throw new Error("no location");
    locationId = data[0].id;
    log("location", { id: locationId, name: data[0].name });
  }

  let vendorId: string | undefined;
  const vendorArg = arg("vendor");
  if (vendorArg) {
    const { data: vendors } = await svc.from("vendors").select("id, name");
    const v = (vendors ?? []).find((x) => x.id === vendorArg) ?? (vendors ?? []).find((x) => x.name.toLowerCase().includes(vendorArg.toLowerCase()));
    if (!v) throw new Error(`no vendor matching "${vendorArg}" (have: ${(vendors ?? []).map((x) => x.name).join(", ")})`);
    vendorId = v.id;
  }

  const results: QuoteRequestResult[] = hasFlag("shock")
    ? await requestsForPriceShock({ locationId, dry, log, svc })
    : await sendQuoteRequests({ locationId, vendorId, force: Boolean(vendorId), dry, log, svc });

  if (results.length === 0) {
    console.log(hasFlag("shock") ? "No ingredient shows a ≥ 10% 30-day price change; nothing to ask." : "No vendor has a mapping yet; nothing to ask.");
    return;
  }
  for (const r of results) {
    console.log("");
    console.log(`==== ${r.vendorName} → ${r.to ?? "(no contact_email — set it in Settings → Vendors)"}  ${r.skipped ? `SKIPPED: ${r.skipped}` : r.sent ? `SENT ${r.resendMessageId}` : dry ? "DRY RUN" : ""}`);
    console.log(`Subject: ${r.subject}`);
    console.log("");
    console.log(r.text);
  }
  console.log("");
  console.table(results.map((r) => ({ vendor: r.vendorName, to: r.to, items: r.items.length, token: r.token, sent: r.sent, skipped: r.skipped, request: r.requestId?.slice(0, 8) ?? null })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
