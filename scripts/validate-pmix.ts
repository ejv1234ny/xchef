/**
 * pnpm tsx scripts/validate-pmix.ts --date YYYY-MM-DD [--closeout 4] [--no-mcp] [--out docs/validation/phase1.md]
 *
 * Phase 1 self-check. For one business date, compares three independent counts:
 *   A. `pmix`   — sales_facts as rebuilt by the app (lib/core/flatten.ts)
 *   B. `rest`   — a second, deliberately naive walk of the raw ordersBulk JSON
 *                 (no shared code with flatten.ts): per item.guid, non-voided
 *                 selection quantities, orders filtered by Toast businessDate
 *   C. `mcp`    — the community Toast MCP server's toast_find_orders for the
 *                 business-day window (closeout hour → next closeout hour, local
 *                 time), summed by item NAME. The MCP summary has no item guid,
 *                 no per-selection void flag and is capped at 100 orders per
 *                 call, so it is reported as a sanity check and flagged when
 *                 truncated; A vs B is the exact comparison.
 * Also compares Σ net_sales (A) with Σ check.amount from the raw orders (B).
 * Appends a markdown section to --out.
 */
import "./_env";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { arg, hasFlag } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { getToastClientForLocation } from "@/lib/jobs/toastSync";
import { toToastDate } from "@/lib/toast/client";
import { pmixForDate } from "./pmix";

type Count = { sold: number; name: string };

function zonedToUtc(dateIso: string, hour: number, tz: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asIf = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += Date.UTC(y, m - 1, d, hour) - asIf;
  }
  return new Date(guess);
}

/** B: naive independent walk of raw ordersBulk JSON for a business date. */
async function restCount(date: string, windowStart: Date, windowEnd: Date) {
  const svc = createServiceSupabase();
  const { data: locs } = await svc.from("locations").select("*").order("created_at").limit(1);
  const location = locs?.[0];
  if (!location) throw new Error("no location");
  const ctx = await getToastClientForLocation(svc, location);
  if (!ctx) throw new Error("no Toast credentials (pnpm creds)");
  const bd = Number(date.replace(/-/g, ""));
  const byGuid = new Map<string, Count>();
  let checkAmount = 0;
  let orders = 0;
  // pull a wide window (±1 day) and filter by businessDate; the app's window logic is not reused
  for (let page = 1; ; page++) {
    const res = await ctx.client.get("/orders/v2/ordersBulk", {
      startDate: toToastDate(new Date(windowStart.getTime() - 86400_000)),
      endDate: toToastDate(new Date(windowEnd.getTime() + 86400_000)),
      page,
      pageSize: 100,
    });
    if (!res.ok) throw new Error(`ordersBulk ${res.status}`);
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    for (const o of raw) {
      if (Number(o.businessDate) !== bd || o.deleted === true) continue;
      orders++;
      const oVoid = o.voided === true;
      for (const c of (o.checks as Array<Record<string, unknown>> | undefined) ?? []) {
        if (c.deleted === true) continue;
        const cVoid = oVoid || c.voided === true;
        if (!cVoid) checkAmount += Number(c.amount ?? 0);
        const walk = (sels: Array<Record<string, unknown>> | undefined, parentVoid: boolean) => {
          for (const s of sels ?? []) {
            const v = parentVoid || s.voided === true;
            const item = s.item as { guid?: string } | null | undefined;
            if (item?.guid && !v) {
              const cur = byGuid.get(item.guid) ?? { sold: 0, name: String(s.displayName ?? item.guid) };
              cur.sold += Number(s.quantity ?? 0);
              byGuid.set(item.guid, cur);
            }
            walk(s.modifiers as Array<Record<string, unknown>> | undefined, v);
          }
        };
        walk(c.selections as Array<Record<string, unknown>> | undefined, cVoid);
      }
    }
    if (raw.length < 100) break;
  }
  return { byGuid, checkAmount, orders };
}

/** C: drive the community Toast MCP server over stdio. */
async function mcpCount(windowStart: Date, windowEnd: Date, restaurantGuid: string | null) {
  const proc = spawn("bash", ["scripts/toast-mcp.sh"], { stdio: ["pipe", "pipe", "inherit"] });
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg.error ? { error: msg.error } : msg.result);
          pending.delete(msg.id);
        }
      } catch {
        /* non-JSON noise */
      }
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  const notify = (method: string, params: unknown) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xchef-validate", version: "0.1" } });
  notify("notifications/initialized", {});
  const result = (await call("tools/call", {
    name: "toast_find_orders",
    arguments: {
      ...(restaurantGuid ? { restaurantGuid } : {}),
      startDate: windowStart.toISOString(),
      endDate: windowEnd.toISOString(),
      limit: 100,
    },
  })) as { structuredContent?: { context?: { dataSource?: string }; orders?: Array<{ voided: boolean; items: Array<{ name: string; quantity: number }>; totalAmount: number }> }; error?: unknown };
  proc.kill();
  const orders = result.structuredContent?.orders ?? [];
  const byName = new Map<string, number>();
  let total = 0;
  for (const o of orders) {
    if (o.voided) continue;
    total += o.totalAmount;
    for (const it of o.items) byName.set(it.name, (byName.get(it.name) ?? 0) + it.quantity);
  }
  return { byName, orders: orders.length, truncated: orders.length >= 100, dataSource: result.structuredContent?.context?.dataSource ?? "unknown", total, error: result.error };
}

async function main() {
  const date = arg("date");
  if (!date) throw new Error("--date YYYY-MM-DD required");
  const closeout = Number(arg("closeout") ?? 4);
  const out = arg("out") ?? "docs/validation/phase1.md";

  const svc = createServiceSupabase();
  const { data: locs } = await svc.from("locations").select("*").order("created_at").limit(1);
  const location = locs![0];
  const tz = location.timezone;
  const windowStart = zonedToUtc(date, closeout, tz);
  const windowEnd = new Date(windowStart.getTime() + 86400_000);

  const a = await pmixForDate(date, location.id);
  const b = await restCount(date, windowStart, windowEnd);
  const c = hasFlag("no-mcp") ? null : await mcpCount(windowStart, windowEnd, location.toast_location_guid).catch((e) => ({ error: String(e) }) as never);

  const guids = new Set<string>([...a.rows.map((r) => r.guid), ...b.byGuid.keys()]);
  const lines: string[] = [];
  let mismatches = 0;
  lines.push(`## Business date ${date}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} · location ${location.name} · tz ${tz} · closeout ${closeout}:00 local`);
  lines.push("");
  lines.push("| item | A pmix (sales_facts) | B raw walk | Δ | C MCP by name |");
  lines.push("|---|---:|---:|---:|---:|");
  const rowsSorted = [...guids]
    .map((g) => {
      const ar = a.rows.find((r) => r.guid === g);
      const br = b.byGuid.get(g);
      const name = ar?.name ?? br?.name ?? g;
      const av = Number(ar?.sold ?? 0);
      const bv = br?.sold ?? 0;
      const cv = c && "byName" in c ? (c.byName.get(name) ?? null) : null;
      return { name, av, bv, cv };
    })
    .sort((x, y) => y.av - x.av);
  for (const r of rowsSorted) {
    const d = r.av - r.bv;
    if (Math.abs(d) > 0.005) mismatches++;
    lines.push(`| ${r.name} | ${r.av.toFixed(2)} | ${r.bv.toFixed(2)} | ${d === 0 ? "" : d.toFixed(2)} | ${r.cv === null ? "" : r.cv.toFixed(2)} |`);
  }
  const aNet = a.rows.reduce((s, r) => s + Number(r.net_sales), 0);
  lines.push("");
  lines.push(`- Orders: A ${a.orders} (raw table) · B ${b.orders} (fresh pull)${c && "orders" in c ? ` · C ${c.orders}${c.truncated ? " (TRUNCATED at 100 — MCP cap)" : ""} [${c.dataSource}]` : ""}`);
  lines.push(`- Σ net_sales (A, selection.price non-voided) = $${aNet.toFixed(2)} · Σ check.amount (B, non-voided) = $${b.checkAmount.toFixed(2)} · Δ $${(aNet - b.checkAmount).toFixed(2)} (differences = check-level discounts/service charges, expected small)`);
  lines.push(`- Items with A≠B: **${mismatches}** → ${mismatches === 0 ? "PASS" : "FAIL — fix lib/core/flatten.ts and its fixture"}`);
  if (c && "error" in c && c.error) lines.push(`- MCP error: ${JSON.stringify(c.error)}`);
  lines.push("");
  mkdirSync(path.dirname(out), { recursive: true });
  appendFileSync(out, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
