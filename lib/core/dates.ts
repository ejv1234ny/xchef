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
