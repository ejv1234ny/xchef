/**
 * pnpm position — materialize daily_position (KICKOFF-2 Part 1).
 *   pnpm position                                   first run: backfill from max(earliest posted
 *                                                   invoice, earliest sales day) → yesterday;
 *                                                   later runs: yesterday + dates needing restatement
 *   pnpm position --from 2026-08-01 --to 2026-08-31 explicit range
 *   pnpm position --location <uuid>                 one location
 * Needs SUPABASE_SERVICE_ROLE_KEY (+ URL) in .env.local.
 */
import "./_env";
import { arg, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { dateRange, reconciliationDate } from "@/lib/core/position";
import { DAILY_POSITION_KIND, runDailyPosition, type DailyPositionRunSummary } from "@/lib/jobs/dailyPosition";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function firstRunRange(locationId: string, timezone: string): Promise<string[] | null> {
  const svc = createServiceSupabase();
  const [{ data: runs }, { count }] = await Promise.all([
    svc.from("sync_runs").select("id").eq("location_id", locationId).eq("kind", DAILY_POSITION_KIND).is("error", null).limit(1),
    svc.from("daily_position").select("*", { count: "exact", head: true }).eq("location_id", locationId),
  ]);
  if ((runs?.length ?? 0) > 0 || (count ?? 0) > 0) return null; // not the first run → job default

  const [{ data: docs }, { data: sales }] = await Promise.all([
    svc.from("invoice_documents").select("received_date, invoice_date").eq("location_id", locationId).eq("status", "posted"),
    svc.from("sales_facts").select("business_date").eq("location_id", locationId).order("business_date").limit(1),
  ]);
  const invoiceDates = (docs ?? []).map((d) => d.received_date ?? d.invoice_date).filter((d): d is string => Boolean(d)).sort();
  const earliestInvoice = invoiceDates[0];
  const earliestSales = sales?.[0]?.business_date;
  const starts = [earliestInvoice, earliestSales].filter((d): d is string => Boolean(d)).sort();
  if (starts.length === 0) return null;
  const start = starts[starts.length - 1]; // whichever is later
  const end = reconciliationDate(timezone);
  if (start > end) return null;
  log("position: first run, backfilling", { start, end, earliestInvoice: earliestInvoice ?? null, earliestSales: earliestSales ?? null });
  return dateRange(start, end);
}

function table(runs: DailyPositionRunSummary[]) {
  console.table(
    runs.map((r) => ({
      location: r.location_name,
      window: r.window_start && r.window_end ? `${r.window_start} → ${r.window_end}` : "—",
      dates: r.dates.length,
      items: r.items,
      rows_written: r.rows_written,
      rows_restated: r.rows_restated,
      item_errors: r.item_errors,
      ms: r.duration_ms,
      error: r.error ?? "",
    })),
  );
}

async function main() {
  const from = arg("from");
  const to = arg("to");
  const locationId = arg("location");
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) throw new Error("--from/--to must be YYYY-MM-DD");
  if ((from && !to) || (!from && to)) throw new Error("--from and --to go together");

  const svc = createServiceSupabase();
  let q = svc.from("locations").select("id, name, timezone").order("created_at");
  if (locationId) q = q.eq("id", locationId);
  const { data: locations, error } = await q;
  if (error) throw error;
  if (!locations?.length) {
    console.log("No location found. Sign in once to bootstrap the tenant.");
    return;
  }

  const runs: DailyPositionRunSummary[] = [];
  for (const loc of locations) {
    const dates = from && to ? dateRange(from, to) : await firstRunRange(loc.id, loc.timezone);
    const { runs: r } = await runDailyPosition({ locationId: loc.id, dates: dates ?? undefined, log });
    runs.push(...r);
  }
  if (runs.length === 0) {
    console.log("Nothing to compute (no inventory and no Toast credentials).");
    return;
  }
  table(runs);
  if (runs.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
