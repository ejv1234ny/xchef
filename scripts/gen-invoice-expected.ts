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
import { normalizeMime, parseInvoiceDocument } from "@/lib/llm/invoice-parse";

const EXTS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

async function main() {
  if (!isLlmConfigured()) {
    console.error("ANTHROPIC_API_KEY is not set; cannot generate expected files.");
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
      const expected = {
        vendor_name: data.vendor_name,
        is_invoice: data.is_invoice,
        document_kind: data.document_kind,
        invoice_number: data.invoice_number ?? null,
        invoice_date: data.invoice_date ?? null,
        subtotal: data.subtotal ?? null,
        total: data.total ?? null,
        line_count: data.lines.length,
        lines: data.lines.map((l) => ({
          line_no: l.line_no,
          vendor_sku: l.vendor_sku ?? null,
          description: l.description,
          pack_size_text: l.pack_size_text ?? null,
          quantity: l.quantity,
          unit_price: l.unit_price ?? null,
          extended_price: l.extended_price ?? null,
          category_guess: l.category_guess,
        })),
        generated_by: "scripts/gen-invoice-expected.ts — review by hand before trusting",
      };
      writeFileSync(out, JSON.stringify(expected, null, 2) + "\n");
      rows.push({ file: f, vendor: data.vendor_name, kind: data.document_kind, lines: data.lines.length, subtotal: data.subtotal ?? null, cost_usd: usage.cost_usd.toFixed(4) });
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
