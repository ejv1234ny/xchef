import Decimal from "decimal.js";
import { addDays } from "./dates";

/**
 * Daily reconciliation math (KICKOFF-2 Part 1). Pure: no I/O, strings in,
 * strings out, Decimal in between. The job (lib/jobs/dailyPosition.ts) feeds
 * one item × one business date at a time, in date order, so each day's
 * opening is the previous day's close.
 *
 * Open/close semantics mirror the SQL views so daily rows and the live views
 * never disagree:
 *   - on_hand_estimate: the latest count is the baseline; an `open` count's
 *     own day counts as "since" (since_date = count_date), a `close` count's
 *     day does not (since_date = count_date + 1). When a day has both, `close`
 *     wins (order by position desc).
 *   - count_variance: variance at a close count = prev + purchased − used −
 *     counted, positive = short.
 * Encoded here as:
 *   - an `open` count REPLACES the opening for that day (expected_close =
 *     count + received − used); it records verification but no variance.
 *   - a `close` count sets counted_qty; variance = expected_close − counted
 *     (positive = unexplained depletion); variance_value = variance × cost.
 *   - a `confirmed_estimate` (✓ tap) is a count by construction equal to the
 *     estimate the owner saw: it records verification and counted_qty (the
 *     baseline the views reset to) but never a variance (null).
 *   - the next day's opening = counted_qty when a close count landed, else
 *     expected_close_qty (see `nextOpening`).
 */

export type PositionCount = {
  id: string;
  quantity_base_unit: string;
  position: "open" | "close";
  verification: "confirmed_estimate" | "counted";
  counted_at: string;
};

export type DailyPositionInput = {
  business_date: string;
  /** prior day's expected close (or counted close), or the baseline from the latest earlier count; base units */
  opening_qty: string;
  /** posted invoice lines received that day, base units */
  received_qty: string;
  /** usage_by_period.quantity_used for that day */
  theoretical_used_qty: string;
  /** the day's principal count: the close count when there is one, else the open count */
  count?: PositionCount | null;
  /** the day's open count when `count` is a close count and both landed the same day */
  open_count?: PositionCount | null;
  cost_per_base_unit: string | null;
  included_invoice_ids?: string[];
  /** carried forward from the previous day so "last checked N days ago" survives days without a count */
  prior_last_verified_at?: string | null;
};

export type DailyPositionRow = {
  business_date: string;
  opening_qty: string;
  received_qty: string;
  theoretical_used_qty: string;
  expected_close_qty: string;
  counted_qty: string | null;
  variance_qty: string | null;
  variance_value: string | null;
  cost_per_base_unit: string | null;
  verification: "none" | "confirmed_estimate" | "counted";
  last_verified_at: string | null;
  included_invoice_ids: string[];
  included_count_id: string | null;
};

const SCALE = 4;
const fix = (d: Decimal): string => d.toFixed(SCALE);

export function computeDailyPosition(input: DailyPositionInput): DailyPositionRow {
  const openCount = input.count?.position === "open" ? input.count : input.open_count?.position === "open" ? input.open_count : null;
  const closeCount = input.count?.position === "close" ? input.count : null;

  const opening = openCount ? new Decimal(openCount.quantity_base_unit) : new Decimal(input.opening_qty);
  const received = new Decimal(input.received_qty);
  const used = new Decimal(input.theoretical_used_qty);
  const expectedClose = opening.plus(received).minus(used);
  const cost = input.cost_per_base_unit == null ? null : new Decimal(input.cost_per_base_unit);

  let counted: Decimal | null = null;
  let variance: Decimal | null = null;
  if (closeCount) {
    counted = new Decimal(closeCount.quantity_base_unit);
    if (closeCount.verification === "counted") variance = expectedClose.minus(counted);
  }

  // The verification recorded for the day is the latest count that landed on it (close wins over open).
  const recorded = closeCount ?? openCount ?? null;

  return {
    business_date: input.business_date,
    opening_qty: fix(opening),
    received_qty: fix(received),
    theoretical_used_qty: fix(used),
    expected_close_qty: fix(expectedClose),
    counted_qty: counted ? fix(counted) : null,
    variance_qty: variance ? fix(variance) : null,
    variance_value: variance ? fix(variance.mul(cost ?? 0)) : null,
    cost_per_base_unit: cost ? fix(cost) : null,
    verification: recorded ? recorded.verification : "none",
    last_verified_at: recorded ? recorded.counted_at : (input.prior_last_verified_at ?? null),
    included_invoice_ids: [...(input.included_invoice_ids ?? [])].sort(),
    included_count_id: recorded ? recorded.id : null,
  };
}

/** What the following day opens with: the counted close when one landed, else the expected close. */
export function nextOpening(row: Pick<DailyPositionRow, "counted_qty" | "expected_close_qty">): string {
  return row.counted_qty ?? row.expected_close_qty;
}

/**
 * Baseline for the first day of a chain when there is no prior daily row:
 * the latest earlier count (or zero) plus purchases minus usage between that
 * count's since-date and the day before the chain starts — exactly the
 * on_hand_estimate window truncated at `first_date − 1`.
 */
export function baselineOpening(input: { count_qty: string | null; purchased_before: string; used_before: string }): string {
  return fix(new Decimal(input.count_qty ?? 0).plus(input.purchased_before).minus(input.used_before));
}

/** First business date whose activity is AFTER a count (mirrors the views' since_date). */
export function sinceDateOf(count: { count_date: string; position: "open" | "close" }): string {
  return count.position === "open" ? count.count_date : addDays(count.count_date, 1);
}

/** Restatement reasons in the order they win when several apply to one day. */
export const RESTATEMENT_REASONS = ["late_invoice", "count_backdated", "sales_rebuild", "recipe_change", "manual"] as const;
export type RestatementReason = (typeof RESTATEMENT_REASONS)[number];

/** Owner-facing words for the "restated (…)" tag. */
export const RESTATEMENT_LABEL: Record<RestatementReason, string> = {
  late_invoice: "late invoice",
  sales_rebuild: "sales rebuilt",
  count_backdated: "backdated count",
  recipe_change: "recipe change",
  manual: "manual",
};

export function restatementLabel(reason: string | null | undefined): string {
  return (reason && (RESTATEMENT_LABEL as Record<string, string>)[reason]) || "restated";
}

export type ComparableRow = Omit<DailyPositionRow, "business_date">;

/** True when a recomputed row differs from what is stored (numeric compare at 4 dp; ids as sorted sets). */
export function rowChanged(prev: ComparableRow, next: ComparableRow): boolean {
  const num = (a: string | null, b: string | null) => (a == null || b == null ? a !== b : !new Decimal(a).equals(new Decimal(b)));
  if (num(prev.opening_qty, next.opening_qty)) return true;
  if (num(prev.received_qty, next.received_qty)) return true;
  if (num(prev.theoretical_used_qty, next.theoretical_used_qty)) return true;
  if (num(prev.expected_close_qty, next.expected_close_qty)) return true;
  if (num(prev.counted_qty, next.counted_qty)) return true;
  if (num(prev.variance_qty, next.variance_qty)) return true;
  if (num(prev.variance_value, next.variance_value)) return true;
  if (num(prev.cost_per_base_unit, next.cost_per_base_unit)) return true;
  if (prev.verification !== next.verification) return true;
  const ts = (t: string | null) => (t == null ? null : Date.parse(t));
  if (ts(prev.last_verified_at ?? null) !== ts(next.last_verified_at ?? null)) return true;
  if ((prev.included_count_id ?? null) !== (next.included_count_id ?? null)) return true;
  const a = [...prev.included_invoice_ids].sort();
  const b = [...next.included_invoice_ids].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
  return false;
}

/** Whole days from a to b (b − a) for plain YYYY-MM-DD strings. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Every date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const BUSINESS_DAY_CUTOFF_HOUR = 4;

/**
 * The business date currently in progress in a timezone: the local calendar
 * date, or the day before when it is earlier than the 4 a.m. cutoff (a bar tab
 * closed at 1 a.m. belongs to the previous business day).
 */
export function currentBusinessDate(timezone: string, now = new Date(), cutoffHour = BUSINESS_DAY_CUTOFF_HOUR): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  return Number(get("hour")) % 24 < cutoffHour ? addDays(today, -1) : today;
}

/** The last completed business date — what the nightly job reconciles. A run at 5 a.m. ET on Sep 5 → Sep 4. */
export function reconciliationDate(timezone: string, now = new Date()): string {
  return addDays(currentBusinessDate(timezone, now), -1);
}
