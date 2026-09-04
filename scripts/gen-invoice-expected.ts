/**
 * pnpm tsx scripts/gen-invoice-expected.ts — parse each fixture invoice with
 * the LLM (no DB) and write `<name>.expected.json` beside it. These files
 * drive lib/llm/invoice-parse.test.ts. Review each one by eye against the PDF
 * before committing: the expected file is the ground truth, not the model.
 *   --only <substring>   only fixtures whose filename contains it
 *   --force              overwrite existing .expected.json
 *   --dir <path>         default fixtures/invoices
 * Needs ANTHROPIC_API_KEY in .env.local.
 */
import "./_env";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { arg, hasFlag } from "./_env";
import { isLlmConfigured } from "@/lib/llm/provider";
import { normalizeMime, normalizeParsedDocument, parseInvoiceDocument, validateParsedDocument } from "@/lib/llm/invoice-parse";

const EXTS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

async function main() {
  if (!isLlmConfigured()) {
    console.error("LLM API key is not set; cannot generate expected files.");
    process.exit(1);
  }
  const dir = path.resolve(process.cwd(), arg("dir") ?? "fixtures/invoices");
  const only = arg("only");
  const files = readdirSync(dir)
    .filter((f) => EXTS.has(path.extname(f).toLowerCase()) && (!only || f.includes(only)))
    .sort();
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const name = f.slice(0, -path.extname(f).length);
    const out = path.join(dir, `${name}.expected.json`);
    if (existsSync(out) && !hasFlag("force")) {
      rows.push({ file: f, skipped: "exists" });
      continue;
    }
    try {
      const bytes = new Uint8Array(readFileSync(path.join(dir, f)));
      const { data, usage } = await parseInvoiceDocument({ bytes, mimeType: normalizeMime("", f), filename: f });
      const docs = data.documents.map(normalizeParsedDocument);
      const expected = {
        documents: docs.map((d) => {
          const v = validateParsedDocument(d);
          return {
            vendor_name: d.vendor_name,
            document_kind: d.document_kind,
            region: d.region ?? null,
            receipt_id: d.receipt_id ?? null,
            transaction_code: d.transaction_code ?? null,
            invoice_date: d.invoice_date ?? null,
            invoice_time: d.invoice_time ?? null,
            subtotal: d.subtotal ?? null,
            total: d.total ?? null,
            printed_item_count: d.printed_item_count ?? null,
            line_count: v.line_count,
            line_sum: v.line_sum,
            validation_ok: v.ok,
            has_adjustments: d.lines.some((l) => (l.adjustment ?? 0) > 0),
            lines: d.lines.map((l) => ({ line_no: l.line_no, vendor_sku: l.vendor_sku ?? null, description: l.description, pack_size_text: l.pack_size_text ?? null, quantity: l.quantity, unit_price: l.unit_price ?? null, gross_price: l.gross_price ?? null, adjustment: l.adjustment ?? null, extended_price: l.extended_price ?? null, category_guess: l.category_guess })),
          };
        }),
        page_notes: data.page_notes ?? null,
        generated_by: "scripts/gen-invoice-expected.ts — review by hand before trusting",
      };
      writeFileSync(out, JSON.stringify(expected, null, 2) + "\n");
      rows.push({ file: f, documents: docs.length, vendors: docs.map((d) => d.vendor_name).join(" | "), lines: docs.map((d) => d.lines.length).join("+"), subtotals: docs.map((d) => d.subtotal ?? "?").join("+"), ok: docs.map((d) => (validateParsedDocument(d).ok ? "✓" : "✗")).join(""), cost_usd: usage.cost_usd.toFixed(4) });
    } catch (e) {
      rows.push({ file: f, error: e instanceof Error ? e.message : String(e) });
    }
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
