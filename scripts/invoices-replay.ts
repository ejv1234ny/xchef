/**
 * pnpm invoices:replay — push every PDF / image in fixtures/invoices through
 * the real pipeline (Storage + DB + LLM) for the first location.
 *   pnpm invoices:replay                    fixtures/invoices
 *   pnpm invoices:replay --dir path/to/dir  another folder
 *   pnpm invoices:replay --location <uuid>  a specific location
 *   pnpm invoices:replay --reparse          re-parse documents that already have lines
 * Needs SUPABASE_SERVICE_ROLE_KEY (+ URL) and ANTHROPIC_API_KEY in .env.local.
 */
import "./_env";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { arg, hasFlag, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { createInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { isAnthropicConfigured } from "@/lib/llm/anthropic";

const EXTS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".csv", ".tsv", ".xlsx", ".xls"]);

async function main() {
  const dir = path.resolve(process.cwd(), arg("dir") ?? "fixtures/invoices");
  const files = readdirSync(dir)
    .filter((f) => EXTS.has(path.extname(f).toLowerCase()) && statSync(path.join(dir, f)).isFile())
    .sort();
  if (files.length === 0) {
    console.log(`No PDF/JPG/PNG/CSV/XLSX files in ${dir}`);
    return;
  }
  if (!isAnthropicConfigured()) console.log("ANTHROPIC_API_KEY not set: documents will be stored as 'received' and not parsed.");

  const svc = createServiceSupabase();
  let locationId = arg("location");
  if (!locationId) {
    const { data, error } = await svc.from("locations").select("id, name").order("created_at").limit(1);
    if (error) throw error;
    if (!data?.[0]) {
      console.log("No location found. Sign in once to bootstrap the tenant.");
      process.exit(1);
    }
    locationId = data[0].id;
    log("replay: location", { id: locationId, name: data[0].name });
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const file = path.join(dir, f);
    const t0 = Date.now();
    try {
      const bytes = new Uint8Array(readFileSync(file));
      const created = await createInvoiceDocument(svc, { locationId, source: "upload", bytes, mimeType: normalizeMime("", f), filename: f });
      const r = await runInvoicePipeline(svc, created.documentId, { log, reparse: hasFlag("reparse") });
      rows.push({ file: f, duplicate: created.duplicate, status: r.status, lines: r.lines, mapped: r.mapped, unmapped: r.unmapped, siblings: r.siblings ?? 0, ms: Date.now() - t0, id: created.documentId.slice(0, 8) });
    } catch (e) {
      rows.push({ file: f, status: "ERROR", error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    }
  }
  console.table(rows);
  if (rows.some((r) => r.status === "ERROR")) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
