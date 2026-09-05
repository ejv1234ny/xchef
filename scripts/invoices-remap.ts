/**
 * pnpm invoices:remap — re-run map → post for every document that still has
 * unmapped lines (default) or for one document.
 *   pnpm invoices:remap                 all needs_review / parsed documents with unmapped lines
 *   pnpm invoices:remap --doc <uuid>    one document
 * Lines the AI calls "new" now create the ingredient from the invoice line
 * itself, so this is how an older invoice's lines become inventory items.
 * Needs SUPABASE_SERVICE_ROLE_KEY (+ URL) and the LLM key in .env.local.
 */
import "./_env";
import { arg, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { mapInvoiceDocument, postInvoiceIfResolved } from "@/lib/jobs/mapInvoice";

async function main() {
  const svc = createServiceSupabase();
  let ids: string[];
  const one = arg("doc");
  if (one) ids = [one];
  else {
    const { data, error } = await svc.from("invoice_lines").select("invoice_id").eq("status", "unmapped");
    if (error) throw error;
    ids = [...new Set((data ?? []).map((r) => r.invoice_id))];
  }
  if (ids.length === 0) {
    console.log("Nothing to remap: no unmapped lines.");
    return;
  }
  let posted = 0;
  for (const id of ids) {
    const m = await mapInvoiceDocument(svc, id, { log });
    const p = await postInvoiceIfResolved(svc, id);
    if (p === "posted") posted += 1;
    console.log(`${id}  mapped=${m.mapped} unmapped=${m.unmapped} ignored=${m.ignored}  → ${p}`);
  }
  console.log(`Done: ${ids.length} document(s), ${posted} posted.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
