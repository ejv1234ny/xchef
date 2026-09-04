/**
 * pnpm invoices:reparse --id <uuid>
 * Re-run parse (LLM or spreadsheet) → map → post for one document, then print
 * its status, line count, vendor and parse_error.
 */
import "./_env";
import { arg, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { runInvoicePipeline } from "@/lib/jobs/intake";
import { selectedProviderName } from "@/lib/llm/provider";

async function main() {
  const id = arg("id");
  if (!id) {
    console.error("usage: pnpm invoices:reparse --id <invoice_documents.id>");
    process.exit(2);
  }
  const svc = createServiceSupabase();
  console.log(`provider: ${selectedProviderName()}`);
  const t0 = Date.now();
  const r = await runInvoicePipeline(svc, id, { reparse: true, log });
  const { data: doc } = await svc.from("invoice_documents").select("status, invoice_number, invoice_date, subtotal, parse_error, parse_confidence, vendor_id, raw_extraction").eq("id", id).single();
  const { data: vendor } = doc?.vendor_id ? await svc.from("vendors").select("name").eq("id", doc.vendor_id).single() : { data: null };
  const { data: call } = await svc.from("llm_calls").select("provider, model, input_tokens, output_tokens, cost_usd, error").eq("ref_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const kind = (doc?.raw_extraction as { document_kind?: string } | null)?.document_kind ?? null;
  console.table([{ id: id.slice(0, 8), status: doc?.status, kind, vendor: vendor?.name ?? null, invoice: doc?.invoice_number ?? null, date: doc?.invoice_date ?? null, subtotal: doc?.subtotal ?? null, lines: r.lines, mapped: r.mapped, unmapped: r.unmapped, confidence: doc?.parse_confidence ?? null, ms: Date.now() - t0 }]);
  if (doc?.parse_error) console.log("parse_error:", doc.parse_error);
  if (call) console.log("llm_calls:", call);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
