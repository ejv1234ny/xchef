import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Json, Tables } from "@/lib/db/types";
import { env } from "@/lib/env";
import { flattenOrders, touchedBusinessDates } from "@/lib/core/flatten";
import { businessDateToIso } from "@/lib/core/dates";
import { ToastClient } from "@/lib/toast/client";
import { OrderSchema, type ToastOrder } from "@/lib/toast/schemas";
import { pollStockStatus, type StockPollSummary } from "./stockPoll";

const HOUR = 3600_000;
const CHUNK_MS = 7 * 24 * HOUR;
const OVERLAP_MS = 36 * HOUR;
const BACKFILL_DAYS = 90;
const UPSERT_BATCH = 200;

export type Logger = (msg: string, meta?: Record<string, unknown>) => void;

export type SyncRunSummary = {
  location_id: string;
  kind: "toast-sync" | "toast-backfill";
  window_start: string;
  window_end: string;
  orders_fetched: number;
  orders_upserted: number;
  orders_quarantined: number;
  dates_rebuilt: string[];
  duration_ms: number;
  error: string | null;
};

export type SyncOptions = {
  locationId?: string;
  /** default true: after the orders window, diff GET /stock/v1/inventory into menu_item_stock_events */
  pollStock?: boolean;
  /** chunks (≤ 7 days each) to process per invocation; cron uses a small number, the CLI uses Infinity */
  maxChunks?: number;
  now?: Date;
  log?: Logger;
  supabase?: ServiceClient;
  /** test seam */
  clientFactory?: (location: Tables<"locations">, creds: Tables<"toast_credentials">, secret: string) => ToastClient;
};

export async function getToastClientForLocation(
  svc: ServiceClient,
  location: Tables<"locations">,
  factory?: SyncOptions["clientFactory"],
): Promise<{ client: ToastClient; creds: Tables<"toast_credentials"> } | null> {
  const { data: creds } = await svc.from("toast_credentials").select("*").eq("location_id", location.id).maybeSingle();
  if (!creds || !location.toast_location_guid) return null;
  const { data: secret, error } = await svc.rpc("get_toast_client_secret", { p_location_id: location.id });
  if (error) throw new Error(`Vault read failed: ${error.message}`);
  if (!secret) return null;
  const client =
    factory?.(location, creds, secret) ??
    new ToastClient({
      host: env.toastApiHost(),
      clientId: creds.client_id,
      clientSecret: secret,
      restaurantGuid: location.toast_location_guid,
    });
  return { client, creds };
}

/** Split [start, end] into ≤ 7-day windows. */
export function planChunks(start: Date, end: Date): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let s = start.getTime();
  const e = end.getTime();
  while (s < e) {
    const ce = Math.min(s + CHUNK_MS, e);
    chunks.push({ start: new Date(s), end: new Date(ce) });
    s = ce;
  }
  return chunks;
}

/**
 * Sync every location that has Toast credentials (or one location). Window =
 * last_synced_at − 36h → now; first run = 90 days back. Windows are processed
 * in ≤ 7-day chunks, last_synced_at advances after each chunk, so a cron run
 * that stops early simply resumes next time. Returns caughtUp=false when
 * chunks remain.
 */
export async function runToastSync(opts: SyncOptions = {}): Promise<{ runs: SyncRunSummary[]; caughtUp: boolean; stock: StockPollSummary[] }> {
  const svc = opts.supabase ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const maxChunks = opts.maxChunks ?? 2;

  let q = svc.from("locations").select("*");
  if (opts.locationId) q = q.eq("id", opts.locationId);
  const { data: locations, error } = await q;
  if (error) throw error;

  const runs: SyncRunSummary[] = [];
  const stock: StockPollSummary[] = [];
  let caughtUp = true;

  for (const location of locations ?? []) {
    const ctx = await getToastClientForLocation(svc, location, opts.clientFactory);
    if (!ctx) {
      log("toast-sync: no credentials, skipping", { location: location.name });
      continue;
    }
    const last = ctx.creds.last_synced_at ? new Date(ctx.creds.last_synced_at) : null;
    const start = last ? new Date(last.getTime() - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 24 * HOUR);
    const kind: SyncRunSummary["kind"] = last ? "toast-sync" : "toast-backfill";
    const chunks = planChunks(start, now);
    const todo = chunks.slice(0, maxChunks);
    if (chunks.length > todo.length) caughtUp = false;

    for (const chunk of todo) {
      const run = await syncWindow(svc, ctx.client, location, chunk.start, chunk.end, kind, log);
      runs.push(run);
      await svc.from("sync_runs").insert({ ...run, dates_rebuilt: run.dates_rebuilt });
      if (run.error) {
        caughtUp = false;
        break; // keep last_synced_at where it was; next run retries this chunk
      }
      await svc
        .from("toast_credentials")
        .update({ last_synced_at: chunk.end.toISOString() })
        .eq("location_id", location.id);
    }
    // 86-list: one cheap read per run; its own summary, never the sync's error.
    if (opts.pollStock !== false) stock.push(await pollStockStatus(svc, ctx.client, location, log, now));
  }
  return { runs, caughtUp, stock };
}

async function syncWindow(
  svc: ServiceClient,
  toast: ToastClient,
  location: Tables<"locations">,
  start: Date,
  end: Date,
  kind: SyncRunSummary["kind"],
  log: Logger,
): Promise<SyncRunSummary> {
  const t0 = Date.now();
  const summary: SyncRunSummary = {
    location_id: location.id,
    kind,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    orders_fetched: 0,
    orders_upserted: 0,
    orders_quarantined: 0,
    dates_rebuilt: [],
    duration_ms: 0,
    error: null,
  };
  try {
    const fetched: ToastOrder[] = [];
    for await (const page of toast.ordersBulk(start, end)) {
      summary.orders_fetched += page.orders.length + page.quarantined.length;
      summary.orders_quarantined += page.quarantined.length;
      for (const q of page.quarantined) log("toast-sync: quarantined order", { guid: q.guid, reason: q.reason });
      fetched.push(...page.orders);
      log("toast-sync: page", { page: page.page, orders: page.orders.length, window: [start.toISOString(), end.toISOString()] });
    }

    for (let i = 0; i < fetched.length; i += UPSERT_BATCH) {
      const batch = fetched.slice(i, i + UPSERT_BATCH).map((o) => ({
        order_guid: o.guid,
        location_id: location.id,
        business_date: businessDateToIso(o.businessDate),
        modified_date: o.modifiedDate,
        voided: Boolean(o.voided),
        payload: o as unknown as Json,
        synced_at: new Date().toISOString(),
      }));
      const { error } = await svc.from("toast_orders_raw").upsert(batch, { onConflict: "location_id,order_guid" });
      if (error) throw new Error(`upsert toast_orders_raw: ${error.message}`);
      summary.orders_upserted += batch.length;
    }

    const dates = touchedBusinessDates(fetched);
    if (dates.length) await rebuildSalesFacts(svc, location.id, dates, log);
    summary.dates_rebuilt = dates;
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
    log("toast-sync: error", { error: summary.error });
  }
  summary.duration_ms = Date.now() - t0;
  return summary;
}

/**
 * Rebuild sales_facts for exactly these business dates from toast_orders_raw,
 * atomically (delete + insert inside one RPC call). Idempotent.
 */
export async function rebuildSalesFacts(svc: ServiceClient, locationId: string, dates: string[], log: Logger = () => {}): Promise<number> {
  const orders: ToastOrder[] = [];
  const PAGE = 500;
  for (const date of dates) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await svc
        .from("toast_orders_raw")
        .select("payload")
        .eq("location_id", locationId)
        .eq("business_date", date)
        .order("order_guid")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`read toast_orders_raw: ${error.message}`);
      for (const row of data ?? []) {
        const parsed = OrderSchema.safeParse(row.payload);
        if (parsed.success) orders.push(parsed.data);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  const rows = flattenOrders(orders).map((r) => ({
    guid: r.toast_menu_item_guid,
    business_date: r.business_date,
    quantity_sold: r.quantity_sold,
    quantity_voided: r.quantity_voided,
    net_sales: r.net_sales,
  }));
  const { data, error } = await svc.rpc("replace_sales_facts", {
    p_location_id: locationId,
    p_dates: dates,
    p_rows: rows as unknown as Json,
  });
  if (error) throw new Error(`replace_sales_facts: ${error.message}`);
  log("toast-sync: rebuilt sales_facts", { dates, rows: data });
  return data ?? 0;
}
