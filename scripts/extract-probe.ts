/**
 * pnpm tsx scripts/extract-probe.ts --file fixtures/invoices/invoice802-1.pdf
 * Runs the full extractor (media prep → parse → normalize → validate → retry)
 * on one file, no database, and prints every document and line. For debugging
 * fixtures and for the report.
 */
import "./_env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { arg, log } from "./_env";
import { extractInvoiceFromFile } from "@/lib/llm/invoice-extract";
import { normalizeMime } from "@/lib/llm/invoice-parse";

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("usage: pnpm tsx scripts/extract-probe.ts --file <pdf|jpg>");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(file));
  const t0 = Date.now();
  const r = await extractInvoiceFromFile({ bytes, mimeType: normalizeMime("", file), filename: path.basename(file) }, { log });
  console.log(`\n${path.basename(file)}: ${r.documents.length} document(s), ${r.attempts.length} attempt(s), media ${JSON.stringify(r.media)}, ${Date.now() - t0} ms, $${r.attempts.reduce((a, x) => a + x.call.usage.cost_usd, 0).toFixed(4)}`);
  if (r.page_notes) console.log("page notes:", r.page_notes);
  r.documents.forEach((d, i) => {
    const v = r.validations[i];
    console.log(`\n[${i + 1}] ${d.region ?? "?"} · ${d.vendor_name} · kind ${d.document_kind} · receipt ${d.receipt_id ?? "-"} · code ${d.transaction_code ?? "-"} · ${d.invoice_date ?? "?"} ${d.invoice_time ?? ""} · printed ${d.printed_item_count ?? "?"} · subtotal ${d.subtotal ?? "?"} tax ${d.tax ?? "?"} total ${d.total ?? "?"} · conf ${d.confidence}`);
    console.log(`    validation: ${v.ok ? "OK" : "FAIL"} · ${v.line_count} lines · Σ ${v.line_sum} vs ${v.subtotal ?? "?"}${v.issues.length ? " · " + v.issues.join("; ") : ""}`);
    for (const l of d.lines) console.log(`    ${String(l.line_no).padStart(2)}  ${l.description.padEnd(34).slice(0, 34)} ${String(l.pack_size_text ?? "").padEnd(8)} qty ${String(l.quantity).padStart(5)} @ ${String(l.unit_price ?? "").padStart(7)}  gross ${String(l.gross_price ?? "").padStart(7)} adj ${String(l.adjustment ?? "").padStart(6)} ext ${String(l.extended_price ?? "").padStart(8)}  ${l.category_guess}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
