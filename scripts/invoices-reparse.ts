/**
 * pnpm invoices:reparse --id <uuid>          re-run parse → map → post for one document
 * pnpm invoices:reparse --source email       every email/forward-sourced document (non-posted)
 * pnpm invoices:reparse --source all         every non-posted, non-manual document
 * Prints, per resulting document: vendor, receipt id, status, lines vs printed
 * item count, Σ lines vs subtotal, and whether validation passed.
 */
import "./_env";
import { arg, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { runInvoicePipeline } from "@/lib/jobs/intake";
import { selectedProviderName } from "@/lib/llm/provider";

type Row = { id: string; source: string; vendor: string | null; receipt: string | null; status: string; kind: string | null; lines: number | null; printed: number | null; sum_lines: string | null; subtotal: string | null; ok: string; note: string | null };

async function describe(svc: ReturnType<typeof createServiceSupabase>, id: string): Promise<Row | null> {
  const { data: d } = await svc.from("invoice_documents").select("id, source, status, receipt_id, invoice_number, subtotal, printed_item_count, parse_error, vendor_id, raw_extraction").eq("id", id).maybeSingle();
  if (!d) return null;
  const { data: vendor } = d.vendor_id ? await svc.from("vendors").select("name").eq("id", d.vendor_id).single() : { data: null };
  const { data: lines } = await svc.from("invoice_lines").select("extended_price, ai_category_guess").eq("invoice_id", id);
  const products = (lines ?? []).filter((l) => !["tax", "fee", "deposit"].includes((l.ai_category_guess ?? "").toLowerCase()));
  const sum = products.reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const ex = d.raw_extraction as { kind?: string; validation?: { ok: boolean }; document?: { document_kind?: string } } | null;
  const kind = ex?.kind === "llm" ? (ex.document?.document_kind ?? null) : ex?.kind === "spreadsheet" ? "spreadsheet" : null;
  const ok = d.status === "rejected" ? "rejected" : ex?.kind === "llm" ? (ex.validation?.ok ? "✓" : "✗") : "-";
  return {
    id: id.slice(0, 8),
    source: d.source,
    vendor: vendor?.name ?? null,
    receipt: d.receipt_id ?? d.invoice_number ?? null,
    status: d.status,
    kind,
    lines: products.length,
    printed: d.printed_item_count,
    sum_lines: sum.toFixed(2),
    subtotal: d.subtotal == null ? null : Number(d.subtotal).toFixed(2),
    ok,
    note: d.parse_error ? d.parse_error.slice(0, 70) : null,
  };
}

async function main() {
  const svc = createServiceSupabase();
  console.log(`provider: ${selectedProviderName()}`);
  const one = arg("id");
  const source = arg("source");
  let ids: string[] = [];
  if (one) ids = [one];
  else if (source) {
    let q = svc.from("invoice_documents").select("id, source, status, raw_extraction").neq("status", "posted").order("created_at");
    if (source === "email") q = q.in("source", ["email", "forward"]);
    else q = q.neq("source", "manual");
    const { data } = await q;
    // only parents (siblings are re-created by their parent's re-parse)
    ids = (data ?? []).filter((d) => !((d.raw_extraction as { parent_document_id?: string | null } | null)?.parent_document_id)).map((d) => d.id);
  } else {
    console.error("usage: pnpm invoices:reparse --id <uuid> | --source email|all");
    process.exit(2);
  }
  const rows: Row[] = [];
  for (const id of ids) {
    const t0 = Date.now();
    try {
      const r = await runInvoicePipeline(svc, id, { reparse: true, log });
      if (r.status === "deleted") {
        rows.push({ id: id.slice(0, 8), source: "?", vendor: null, receipt: null, status: "deleted (duplicate)", kind: null, lines: null, printed: null, sum_lines: null, subtotal: null, ok: "dup", note: null });
        continue;
      }
      const { data: d } = await svc.from("invoice_documents").select("raw_extraction").eq("id", id).single();
      const siblings = ((d?.raw_extraction as { sibling_document_ids?: string[] } | null)?.sibling_document_ids ?? []) as string[];
      for (const did of [id, ...siblings]) {
        const row = await describe(svc, did);
        if (row) rows.push(row);
      }
      log("reparse: done", { id, ms: Date.now() - t0 });
    } catch (e) {
      rows.push({ id: id.slice(0, 8), source: "?", vendor: null, receipt: null, status: "ERROR", kind: null, lines: null, printed: null, sum_lines: null, subtotal: null, ok: "!", note: e instanceof Error ? e.message.slice(0, 70) : String(e) });
    }
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
