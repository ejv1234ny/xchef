import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Tables } from "@/lib/db/types";
import type { ToastClient } from "@/lib/toast/client";
import { parseJobTitles, parseTimeEntries, planLaborWindows } from "@/lib/core/labor";
import { getToastClientForLocation, type Logger, type SyncOptions } from "./toastSync";

/**
 * Labor sync (KICKOFF-3 item 6). GET /labor/v1/timeEntries for
 * `last window_end − 36 h → now` (Toast edits entries after the fact: clock-outs,
 * manager corrections), in ≤ 30-day windows, upserted on (location, toast guid).
 * First run backfills 90 days. Job titles come from GET /labor/v1/jobs; no
 * employee details are requested. Every run is a sync_runs row (kind
 * 'labor-sync': orders_fetched = entries fetched, orders_upserted = rows
 * written, orders_quarantined = invalid entries, dates_rebuilt = business
 * dates touched). Runs from /api/cron/daily-sync and `pnpm labor:sync`.
 */
const HOUR = 3_600_000;
const OVERLAP_MS = 36 * HOUR;
const BACKFILL_DAYS = 90;
const UPSERT_BATCH = 200;
export const LABOR_SYNC_KIND = "labor-sync";

export type LaborSyncSummary = {
  location_id: string;
  location_name: string;
  window_start: string;
  window_end: string;
  entries_fetched: number;
  rows_upserted: number;
  quarantined: number;
  dates: string[];
  duration_ms: number;
  error: string | null;
};

export type LaborSyncOptions = {
  locationId?: string;
  /** override the window start (backfill from here); default: last run − 36 h, or 90 days back */
  since?: Date;
  now?: Date;
  log?: Logger;
  supabase?: ServiceClient;
  clientFactory?: SyncOptions["clientFactory"];
};

export async function runLaborSync(opts: LaborSyncOptions = {}): Promise<LaborSyncSummary[]> {
  const svc = opts.supabase ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();

  let q = svc.from("locations").select("*").order("created_at");
  if (opts.locationId) q = q.eq("id", opts.locationId);
  const { data: locations, error } = await q;
  if (error) throw new Error(`read locations: ${error.message}`);

  const out: LaborSyncSummary[] = [];
  for (const location of locations ?? []) {
    const ctx = await getToastClientForLocation(svc, location, opts.clientFactory);
    if (!ctx) {
      log("labor-sync: no credentials, skipping", { location: location.name });
      continue;
    }
    const { data: lastRuns } = await svc.from("sync_runs").select("window_end").eq("location_id", location.id).eq("kind", LABOR_SYNC_KIND).is("error", null).order("created_at", { ascending: false }).limit(1);
    const last = lastRuns?.[0]?.window_end ? new Date(lastRuns[0].window_end) : null;
    const start = opts.since ?? (last ? new Date(last.getTime() - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 24 * HOUR));
    const summary = await syncLaborWindow(svc, ctx.client, location, start, now, log);
    out.push(summary);
    const { error: serr } = await svc.from("sync_runs").insert({
      location_id: location.id,
      kind: LABOR_SYNC_KIND,
      window_start: summary.window_start,
      window_end: summary.window_end,
      orders_fetched: summary.entries_fetched,
      orders_upserted: summary.rows_upserted,
      orders_quarantined: summary.quarantined,
      dates_rebuilt: summary.dates,
      duration_ms: summary.duration_ms,
      error: summary.error,
    });
    if (serr) log("labor-sync: could not record sync_run", { error: serr.message });
  }
  return out;
}

async function syncLaborWindow(svc: ServiceClient, client: ToastClient, location: Tables<"locations">, start: Date, end: Date, log: Logger): Promise<LaborSyncSummary> {
  const t0 = Date.now();
  const summary: LaborSyncSummary = {
    location_id: location.id,
    location_name: location.name,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    entries_fetched: 0,
    rows_upserted: 0,
    quarantined: 0,
    dates: [],
    duration_ms: 0,
    error: null,
  };
  try {
    const titles = parseJobTitles(await client.jobs());
    const dates = new Set<string>();
    for (const w of planLaborWindows(start, end)) {
      const raw = await client.timeEntries(w.start, w.end);
      const { rows, quarantined } = parseTimeEntries(raw, titles);
      summary.entries_fetched += rows.length + quarantined.length;
      summary.quarantined += quarantined.length;
      for (const q of quarantined) log("labor-sync: quarantined entry", { guid: q.guid, reason: q.reason });
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
          location_id: location.id,
          toast_guid: r.toast_guid,
          employee_guid: r.employee_guid,
          job_guid: r.job_guid,
          job_title: r.job_title,
          business_date: r.business_date,
          clock_in: r.clock_in,
          clock_out: r.clock_out,
          // numeric columns: fixed strings keep the exact decimals (the generated types say number)
          regular_hours: r.regular_hours as unknown as number,
          overtime_hours: r.overtime_hours as unknown as number,
          wage: r.wage as unknown as number | null,
          tips_declared: r.tips_declared as unknown as number | null,
          cash_tips: r.cash_tips as unknown as number | null,
          non_cash_tips: r.non_cash_tips as unknown as number | null,
          deleted: r.deleted,
          toast_modified_at: r.toast_modified_at,
          synced_at: new Date().toISOString(),
        }));
        const { error } = await svc.from("labor_entries").upsert(batch, { onConflict: "location_id,toast_guid" });
        if (error) throw new Error(`upsert labor_entries: ${error.message}`);
        summary.rows_upserted += batch.length;
        for (const r of batch) dates.add(r.business_date);
      }
      log("labor-sync: window", { location: location.name, window: [w.start.toISOString(), w.end.toISOString()], entries: rows.length, quarantined: quarantined.length });
    }
    summary.dates = [...dates].sort();
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
    log("labor-sync: error", { location: location.name, error: summary.error });
  }
  summary.duration_ms = Date.now() - t0;
  return summary;
}
