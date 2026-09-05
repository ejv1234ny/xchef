/**
 * pnpm portal:pull [--vendor pfg|sysco] [--dry] [--since YYYY-MM-DD] [--artifacts dir]
 *
 * Vendor-portal pull (KICKOFF-2 Part 2). For every adapter whose credentials
 * are set (PORTAL_<VENDOR>_USER / _PASS), launch chromium, pull the invoices
 * posted since max(invoice_date) − 3 days for that vendor (14 days when the
 * vendor has none, or when the database is not reachable), and POST each file
 * to `${XCHEF_BASE_URL}/api/intake/upload` with
 *   x-intake-key      XCHEF_INTAKE_KEY (or INTAKE_API_KEY)
 *   x-vendor          adapter.vendor
 *   x-invoice-number  as listed on the portal
 * so the file enters the normal intake → parse → map → post pipeline as
 * source 'api' and attaches to the paper copy when one exists.
 *
 * --dry skips the browser entirely and exercises intake auth + attach/dedupe
 * end to end with fixtures/invoices/synthetic-rd-receipt.csv (vendor
 * "Restaurant Depot", invoice number from its Transaction line):
 *   POST 1  → a new document (source 'api'), parsed and mapped
 *   POST 2  → same bytes: dedupes onto that document (no second document)
 *   POST 3  → byte-different copy, same invoice number: attaches as the
 *             clean copy (clean_storage_path) — still no second document
 * Exits non-zero when any adapter fails or the dry run does not behave.
 *
 * Runs in GitHub Actions (.github/workflows/portal-pull.yml) — not on Vercel.
 */
import "./_env";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { arg, hasFlag, log } from "./_env";
import { parseTransactionLine } from "@/lib/core/sheets";
import { adapterFor, hasCredentials, PORTAL_ADAPTERS, PORTAL_VENDOR_ALIASES, portalKeys, type PortalInvoice } from "@/lib/portals";

const DEFAULT_LOOKBACK_DAYS = 14;
const OVERLAP_DAYS = 3;

type UploadResponse = {
  documentId?: string;
  status?: string;
  duplicate?: boolean;
  attached?: boolean;
  attachedTo?: string;
  outcome?: string;
  lines?: number;
  mapped?: number;
  unmapped?: number;
  error?: string;
};

function baseUrl(): string {
  const u = process.env.XCHEF_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!u) throw new Error("XCHEF_BASE_URL (or NEXT_PUBLIC_APP_URL) is required");
  return u.replace(/\/+$/, "");
}

function intakeKey(): string {
  const k = process.env.XCHEF_INTAKE_KEY ?? process.env.INTAKE_API_KEY;
  if (!k) throw new Error("XCHEF_INTAKE_KEY (or INTAKE_API_KEY) is required");
  return k;
}

function isoDaysAgo(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function postInvoice(inv: PortalInvoice, vendor: string, locationId?: string): Promise<{ http: number; body: UploadResponse }> {
  const form = new FormData();
  form.append("file", new Blob([inv.buffer as BlobPart], { type: inv.mime }), inv.filename);
  const url = new URL(`${baseUrl()}/api/intake/upload`);
  if (locationId) url.searchParams.set("location", locationId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-intake-key": intakeKey(), "x-vendor": vendor, "x-invoice-number": inv.invoiceNumber },
    body: form,
  });
  let body: UploadResponse = {};
  try {
    body = (await res.json()) as UploadResponse;
  } catch {
    body = { error: `non-JSON response (${res.status})` };
  }
  return { http: res.status, body };
}

/** max(invoice_date) − 3 days for the vendor, from the database; null when the DB env is absent or the vendor has no invoices. */
async function sinceFromDb(key: string, vendorName: string): Promise<string | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log("portal-pull: no database env, using the default lookback", { vendor: vendorName, days: DEFAULT_LOOKBACK_DAYS });
    return null;
  }
  const { createServiceSupabase } = await import("@/lib/db/service");
  const svc = createServiceSupabase();
  const names = PORTAL_VENDOR_ALIASES[key] ?? [vendorName];
  const { data: vendors, error } = await svc.from("vendors").select("id, name");
  if (error) throw new Error(`read vendors: ${error.message}`);
  const ids = (vendors ?? []).filter((v) => names.some((n) => v.name.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(v.name.toLowerCase()))).map((v) => v.id);
  if (ids.length === 0) return null;
  const { data } = await svc.from("invoice_documents").select("invoice_date").in("vendor_id", ids).not("invoice_date", "is", null).order("invoice_date", { ascending: false }).limit(1);
  const latest = data?.[0]?.invoice_date ?? null;
  return latest ? minusDays(latest, OVERLAP_DAYS) : null;
}

async function runAdapters(): Promise<number> {
  const only = arg("vendor");
  const keys = only ? [only.toLowerCase()] : portalKeys();
  const artifactsDir = path.resolve(process.cwd(), arg("artifacts") ?? "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  let failures = 0;

  const ready = keys.filter((k) => {
    const a = adapterFor(k);
    if (!a) {
      rows.push({ vendor: k, status: "ERROR", error: `unknown adapter; known: ${portalKeys().join(", ")}` });
      failures++;
      return false;
    }
    if (!hasCredentials(a)) {
      rows.push({ vendor: a.vendor, status: "skipped", error: `set ${a.env.user} and ${a.env.pass}` });
      return false;
    }
    return true;
  });
  if (ready.length === 0) {
    console.table(rows);
    console.log("No adapter has credentials; nothing pulled.");
    return failures;
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const key of ready) {
      const adapter = PORTAL_ADAPTERS[key];
      const t0 = Date.now();
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      try {
        const since = arg("since") ?? (await sinceFromDb(key, adapter.vendor)) ?? isoDaysAgo(DEFAULT_LOOKBACK_DAYS);
        log("portal-pull: start", { vendor: adapter.vendor, since });
        const invoices = await adapter.pull({ page, since, log, artifactsDir });
        if (invoices.length === 0) rows.push({ vendor: adapter.vendor, since, status: "empty", invoices: 0, ms: Date.now() - t0 });
        for (const inv of invoices) {
          const r = await postInvoice(inv, adapter.vendor);
          const ok = r.http >= 200 && r.http < 300;
          if (!ok) failures++;
          rows.push({
            vendor: adapter.vendor,
            invoice: inv.invoiceNumber,
            date: inv.invoiceDate,
            file: inv.filename,
            http: r.http,
            status: ok ? r.body.status : "ERROR",
            outcome: r.body.attached ? `attached:${r.body.outcome}` : r.body.duplicate ? "duplicate" : "created",
            id: r.body.documentId?.slice(0, 8) ?? "",
            error: r.body.error ?? "",
          });
        }
      } catch (e) {
        failures++;
        rows.push({ vendor: adapter.vendor, status: "ERROR", error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.table(rows);
  return failures;
}

/**
 * --dry: fixture spreadsheet through the live endpoint, three times. The
 * fixture's invoice number (I99001) is made unique per run — digits appended,
 * still parsed by the Restaurant Depot layout — so the first POST is a real
 * creation even when an earlier run (or `pnpm invoices:replay`) already stored
 * the fixture. The document it creates is synthetic: when the database env is
 * present the script deletes it (and its lines, files and inbound_events) at
 * the end unless --keep; otherwise it prints the id and the cleanup command.
 */
async function runDry(): Promise<number> {
  const fixture = path.resolve(process.cwd(), "fixtures/invoices/synthetic-rd-receipt.csv");
  const fixtureText = readFileSync(fixture, "utf8");
  const txLine = fixtureText.split(/\r?\n/).find((l) => l.startsWith("Transaction,"));
  const base = parseTransactionLine(txLine?.slice("Transaction,".length) ?? "");
  if (!base.invoiceNumber || !base.date) throw new Error(`fixture has no Transaction line: ${fixture}`);
  const runNumber = `${base.invoiceNumber}${Date.now().toString().slice(-9)}`;
  const text = fixtureText.replace(base.invoiceNumber, runNumber);
  const tx = parseTransactionLine(text.split(/\r?\n/).find((l) => l.startsWith("Transaction,"))?.slice("Transaction,".length) ?? "");
  if (tx.invoiceNumber !== runNumber) throw new Error(`could not stamp the run's invoice number into the fixture (${tx.invoiceNumber} ≠ ${runNumber})`);
  const vendor = "Restaurant Depot";
  const locationId = arg("location");
  log("portal-pull: dry run", { base: baseUrl(), vendor, invoiceNumber: runNumber, invoiceDate: tx.date, fixture: path.basename(fixture) });

  const original = new Uint8Array(Buffer.from(text, "utf8"));
  // Same invoice, different bytes: only the free-text note above the header changes (ignored by the RD layout).
  const variant = new Uint8Array(Buffer.from(text.replace(/^Note: .*$/m, `Note: portal copy pulled ${new Date().toISOString()}`), "utf8"));
  if (Buffer.compare(Buffer.from(original), Buffer.from(variant)) === 0) throw new Error("fixture variant did not change; cannot exercise attach");

  const make = (buffer: Uint8Array, filename: string): PortalInvoice => ({ invoiceNumber: runNumber, invoiceDate: tx.date!, buffer, mime: "text/csv", filename });
  const rows: Array<Record<string, unknown>> = [];
  const results: Array<{ http: number; body: UploadResponse }> = [];
  const steps: Array<{ label: string; inv: PortalInvoice }> = [
    { label: "1 create", inv: make(original, "synthetic-rd-receipt.csv") },
    { label: "2 same bytes", inv: make(original, "synthetic-rd-receipt.csv") },
    { label: "3 clean copy", inv: make(variant, "synthetic-rd-receipt-portal.csv") },
  ];
  for (const s of steps) {
    const t0 = Date.now();
    const r = await postInvoice(s.inv, vendor, locationId);
    results.push(r);
    rows.push({ step: s.label, http: r.http, documentId: r.body.documentId ?? "", status: r.body.status ?? "", duplicate: r.body.duplicate ?? "", attached: r.body.attached ?? false, outcome: r.body.outcome ?? "", lines: r.body.lines ?? "", mapped: r.body.mapped ?? "", ms: Date.now() - t0, error: r.body.error ?? "" });
  }
  console.table(rows);

  const problems: string[] = [];
  const [a, b, c] = results;
  if (results.some((r) => r.http !== 200)) problems.push(`HTTP status not 200: ${results.map((r) => r.http).join(", ")}`);
  if (!a.body.documentId) problems.push("first POST returned no documentId");
  if (a.body.duplicate) log("portal-pull: note — the fixture already existed before this run (first POST deduped); the checks below still hold", {});
  if (b.body.documentId !== a.body.documentId) problems.push(`second POST created a different document (${b.body.documentId} vs ${a.body.documentId})`);
  if (!b.body.duplicate) problems.push("second POST was not reported as a duplicate");
  if (c.body.documentId !== a.body.documentId) problems.push(`third POST created a different document (${c.body.documentId} vs ${a.body.documentId})`);
  if (!c.body.attached) problems.push("third POST did not attach to the first document");
  if (problems.length) for (const p of problems) console.error(`dry run FAILED: ${p}`);
  else console.log(`dry run OK: document ${a.body.documentId} — created (${a.body.status}, ${a.body.lines} lines, ${a.body.mapped} mapped), then deduped, then attached (${c.body.outcome}).`);

  if (a.body.documentId) await cleanupDryRunDocument(a.body.documentId);
  return problems.length;
}

/** The dry run's document is synthetic; remove it when we can reach the database, otherwise say how. */
async function cleanupDryRunDocument(documentId: string): Promise<void> {
  if (hasFlag("keep")) {
    console.log(`--keep: leaving synthetic document ${documentId} in place.`);
    return;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log(`CLEANUP NEEDED: synthetic document ${documentId} was created by this dry run and this runner has no database access. Locally: pnpm portal:pull --dry (it self-cleans), or delete it from Invoices.`);
    return;
  }
  const { createServiceSupabase } = await import("@/lib/db/service");
  const { INVOICES_BUCKET } = await import("@/lib/storage");
  const svc = createServiceSupabase();
  const { data: doc } = await svc.from("invoice_documents").select("id, storage_path, clean_storage_path").eq("id", documentId).maybeSingle();
  if (!doc) return;
  await svc.from("invoice_lines").delete().eq("invoice_id", documentId);
  const { error } = await svc.from("invoice_documents").delete().eq("id", documentId);
  if (error) {
    console.error(`cleanup: could not delete ${documentId}: ${error.message}`);
    return;
  }
  const paths = [doc.storage_path, doc.clean_storage_path].filter((p): p is string => Boolean(p));
  if (paths.length) await svc.storage.from(INVOICES_BUCKET).remove(paths);
  await svc.from("inbound_events").delete().eq("provider", "portal").contains("document_ids", [documentId]);
  console.log(`cleanup: removed synthetic document ${documentId}, its lines, ${paths.length} stored file(s) and its inbound_events rows.`);
}

async function main() {
  const failures = hasFlag("dry") ? await runDry() : await runAdapters();
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
