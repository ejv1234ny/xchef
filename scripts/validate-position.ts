/**
 * pnpm validate:position [--location <uuid>] [--out docs/validation/position.md]
 *
 * Gate 1 self-check (KICKOFF-2 Part 1). For the latest business date in
 * daily_position, asserts that the daily chain agrees with the live view:
 *
 *   daily_position.expected_close_qty (or counted_qty when a close count landed
 *   that day — the baseline the view resets to)
 *   + purchases_by_item after that date − usage_by_period after that date
 *   == on_hand_estimate.on_hand_qty   (± 0.0001)
 *
 * The "after that date" terms are the live view's own inputs for activity the
 * daily job has not reconciled yet (today's sales); they are read from the
 * views, never recomputed. Items whose latest count is AFTER the latest daily
 * row are reported as skipped (the view's baseline moved past the daily row).
 * Every item is checked; the spec's gate is the subset with has_baseline = true.
 * Appends a dated section to --out and exits 1 on any mismatch.
 */
import "./_env";
import Decimal from "decimal.js";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { arg } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";

const TOLERANCE = new Decimal("0.0001");
const PAGE = 1000;

const HEADER = `# daily_position ↔ on_hand_estimate validation

Gate 1 of KICKOFF-2 Part 1. \`pnpm validate:position\` takes the latest business
date in \`daily_position\` and, for every inventory item at the location, checks
that the daily chain's close for that date (expected close, or the counted close
when a close count landed that day) plus any purchases and theoretical usage the
live view already sees after that date equals \`on_hand_estimate.on_hand_qty\`
within ±0.0001 base units. The daily rows are materialized by
\`lib/jobs/dailyPosition.ts\` from the same views the estimate reads
(\`purchases_by_item\`, \`usage_by_period\`, \`stock_counts\`), so any drift here is a
bug in the open/close semantics of \`lib/core/position.ts\`. Sections below are
appended by the script, newest last.
`;

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const dec = (n: number | string | null | undefined) => new Decimal(n == null ? 0 : String(n));

async function main() {
  const out = arg("out") ?? "docs/validation/position.md";
  const svc = createServiceSupabase();

  let lq = svc.from("locations").select("id, name, timezone").order("created_at").limit(1);
  if (arg("location")) lq = lq.eq("id", arg("location")!);
  const { data: locs, error: lerr } = await lq;
  if (lerr) throw lerr;
  const location = locs?.[0];
  if (!location) throw new Error("no location");

  const { data: latestRows, error: derr } = await svc
    .from("daily_position")
    .select("business_date")
    .eq("location_id", location.id)
    .order("business_date", { ascending: false })
    .limit(1);
  if (derr) throw derr;
  const date = latestRows?.[0]?.business_date;
  if (!date) throw new Error("daily_position is empty for this location — run `pnpm position` first");

  const [daily, live, purchAfter, usedAfter] = await Promise.all([
    fetchAll<{ inventory_item_id: string; expected_close_qty: number; counted_qty: number | null; restated_at: string | null; restatement_reason: string | null }>((from, to) =>
      svc.from("daily_position").select("inventory_item_id, expected_close_qty, counted_qty, restated_at, restatement_reason").eq("location_id", location.id).eq("business_date", date).order("inventory_item_id").range(from, to),
    ),
    fetchAll<{ inventory_item_id: string | null; inventory_item_name: string | null; base_unit: string | null; has_baseline: boolean | null; on_hand_qty: number | null; last_count_date: string | null }>((from, to) =>
      svc.from("on_hand_estimate").select("inventory_item_id, inventory_item_name, base_unit, has_baseline, on_hand_qty, last_count_date").eq("location_id", location.id).order("inventory_item_id").range(from, to),
    ),
    fetchAll<{ inventory_item_id: string | null; quantity_base_unit: number | null }>((from, to) =>
      svc.from("purchases_by_item").select("inventory_item_id, quantity_base_unit").eq("location_id", location.id).gt("received_date", date).order("inventory_item_id").order("received_date").range(from, to),
    ),
    fetchAll<{ inventory_item_id: string | null; quantity_used: number | null }>((from, to) =>
      svc.from("usage_by_period").select("inventory_item_id, quantity_used").eq("location_id", location.id).gt("business_date", date).order("inventory_item_id").order("business_date").range(from, to),
    ),
  ]);

  const dailyById = new Map(daily.map((r) => [r.inventory_item_id, r]));
  const after = new Map<string, Decimal>();
  for (const p of purchAfter) if (p.inventory_item_id) after.set(p.inventory_item_id, (after.get(p.inventory_item_id) ?? new Decimal(0)).plus(dec(p.quantity_base_unit)));
  for (const u of usedAfter) if (u.inventory_item_id) after.set(u.inventory_item_id, (after.get(u.inventory_item_id) ?? new Decimal(0)).minus(dec(u.quantity_used)));

  type Result = { name: string; unit: string; baseline: boolean; daily: string; adj: string; live: string; delta: string; status: "PASS" | "FAIL" | "MISSING" | "SKIP"; restated: string };
  const results: Result[] = [];
  for (const e of live) {
    if (!e.inventory_item_id) continue;
    const d = dailyById.get(e.inventory_item_id);
    const name = e.inventory_item_name ?? e.inventory_item_id;
    const baseline = e.has_baseline === true;
    const liveQty = dec(e.on_hand_qty);
    if (!d) {
      results.push({ name, unit: e.base_unit ?? "", baseline, daily: "—", adj: "", live: liveQty.toFixed(4), delta: "", status: "MISSING", restated: "" });
      continue;
    }
    const closeOfDay = d.counted_qty != null ? dec(d.counted_qty) : dec(d.expected_close_qty);
    const adj = after.get(e.inventory_item_id) ?? new Decimal(0);
    const expected = closeOfDay.plus(adj);
    const delta = expected.minus(liveQty);
    const skip = e.last_count_date != null && e.last_count_date > date;
    const ok = delta.abs().lte(TOLERANCE);
    results.push({
      name,
      unit: e.base_unit ?? "",
      baseline,
      daily: closeOfDay.toFixed(4),
      adj: adj.isZero() ? "" : adj.toFixed(4),
      live: liveQty.toFixed(4),
      delta: delta.isZero() ? "" : delta.toFixed(4),
      status: skip ? "SKIP" : ok ? "PASS" : "FAIL",
      restated: d.restated_at ? (d.restatement_reason ?? "restated") : "",
    });
  }
  results.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status.localeCompare(b.status)));

  const tally = (pred: (r: Result) => boolean) => {
    const rows = results.filter(pred);
    return { pass: rows.filter((r) => r.status === "PASS").length, fail: rows.filter((r) => r.status === "FAIL" || r.status === "MISSING").length, skip: rows.filter((r) => r.status === "SKIP").length, total: rows.length };
  };
  const withBaseline = tally((r) => r.baseline);
  const all = tally(() => true);

  const lines: string[] = [];
  lines.push(`## Business date ${date}`);
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} · location ${location.name} · tz ${location.timezone} · tolerance ±${TOLERANCE.toFixed(4)}`);
  lines.push("");
  lines.push(`- Items with a baseline (spec gate): **${withBaseline.pass} pass / ${withBaseline.fail} fail** of ${withBaseline.total}${withBaseline.skip ? ` (${withBaseline.skip} skipped: count after ${date})` : ""}`);
  lines.push(`- All items: **${all.pass} pass / ${all.fail} fail** of ${all.total}${all.skip ? ` (${all.skip} skipped)` : ""}`);
  lines.push(`- Result: ${all.fail === 0 ? "PASS" : "FAIL — fix lib/core/position.ts / lib/jobs/dailyPosition.ts"}`);
  lines.push("");
  lines.push("| item | unit | baseline | daily close | + after date | live on_hand | Δ | status | restated |");
  lines.push("|---|---|:-:|---:|---:|---:|---:|---|---|");
  for (const r of results) lines.push(`| ${r.name} | ${r.unit} | ${r.baseline ? "yes" : ""} | ${r.daily} | ${r.adj} | ${r.live} | ${r.delta} | ${r.status} | ${r.restated} |`);
  lines.push("");

  mkdirSync(path.dirname(out), { recursive: true });
  if (!existsSync(out)) writeFileSync(out, `${HEADER}\n`);
  appendFileSync(out, `${lines.join("\n")}\n`);

  console.table(results.map((r) => ({ item: r.name.slice(0, 32), unit: r.unit, baseline: r.baseline ? "yes" : "", daily: r.daily, after: r.adj, live: r.live, delta: r.delta, status: r.status, restated: r.restated })));
  console.log(lines.slice(0, 7).join("\n"));
  process.exit(all.fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
