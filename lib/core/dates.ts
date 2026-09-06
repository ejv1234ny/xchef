/** Toast businessDate (int 20260903 or "20260903") → "2026-09-03". */
export function businessDateToIso(bd: number | string): string {
  const s = String(bd).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (!/^\d{8}$/.test(s)) throw new Error(`Bad Toast businessDate: ${bd}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-09-03" → 20260903 */
export function isoToBusinessDate(iso: string): number {
  return Number(iso.replace(/-/g, ""));
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in a location's IANA timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Local hour (0–23) in a timezone; used for the open/close default on the verify page. */
export function hourIn(timezone: string, now = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(now);
  return Number(h) % 24;
}

/** The UTC instant of `hour`:00 local on a calendar date in an IANA timezone (DST-safe, two passes). */
export function zonedTimeToUtc(dateIso: string, hour: number, timezone: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asIf = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += Date.UTC(y, m - 1, d, hour) - asIf;
  }
  return new Date(guess);
}

/** A Toast business day: cutoff (4 a.m. local by default) on the date → the same cutoff the next day. */
export function businessDayWindow(businessDate: string, timezone: string, cutoffHour = 4): { start: Date; end: Date } {
  return { start: zonedTimeToUtc(businessDate, cutoffHour, timezone), end: zonedTimeToUtc(addDays(businessDate, 1), cutoffHour, timezone) };
}
