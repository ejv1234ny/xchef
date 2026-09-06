/**
 * Display-only helpers shared by the verify / on-hand / prices / invoices
 * screens. Nothing here computes a business number — the SQL views do that
 * (CLAUDE.md rule 8). These format what the views return for a phone screen.
 */

const money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money3 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 });
const one = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const upToOne = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "$1,234.56" — money always with 2 decimals. */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return money2.format(n);
}

/** Unit costs are often fractions of a cent ("$0.098/oz"): 2–3 decimals. */
export function fmtUnitCost(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return money3.format(n);
}

/** Packs with exactly 1 decimal: "11.4". */
export function fmtPacks(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return one.format(n);
}

/** Base-unit quantities with up to 1 decimal: "1,272" / "297.8". */
export function fmtQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return upToOne.format(n);
}

/** "+12%" / "−5%"; blank when null. */
export function fmtPctChange(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  const pct = Math.round(n * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

/** Whole days: "~3 days left". */
export function fmtDays(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "";
  const d = Math.max(0, Math.round(n));
  return `~${d} day${d === 1 ? "" : "s"} left`;
}

/** "2026-09-03" → "Sep 3" (no timezone math: business dates are plain strings). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/**
 * The word for one pack of an item, used in "You should have ~11.4 bottles".
 * Heuristic on purpose (kept simple per the brief): the item name wins when it
 * says keg / can / bottle / case, otherwise "packs". Returns null when the item
 * has no pack_to_base_factor, in which case callers show base units.
 */
export function packWord(name: string | null | undefined, packToBaseFactor: number | null | undefined, count = 2): string | null {
  if (packToBaseFactor == null || packToBaseFactor <= 0) return null;
  const n = (name ?? "").toLowerCase();
  const plural = Math.abs(count - 1) > 1e-9;
  const pick = (s: string, p: string) => (plural ? p : s);
  if (/\bkeg/.test(n)) return pick("keg", "kegs");
  if (/\bcans?\b/.test(n)) return pick("can", "cans");
  if (/\bbottle|\bbtl\b/.test(n)) return pick("bottle", "bottles");
  if (/\bcase\b|\bcs\b/.test(n)) return pick("case", "cases");
  return pick("pack", "packs");
}

/** "~11.4 bottles" or "~297.8 oz" — the expectation line on the verify screen. */
export function expectationText(row: {
  inventory_item_name: string | null;
  base_unit: string | null;
  on_hand_qty: number | null;
  on_hand_packs: number | null;
  pack_to_base_factor: number | null;
}): string {
  const word = packWord(row.inventory_item_name, row.pack_to_base_factor, row.on_hand_packs ?? 2);
  if (row.on_hand_packs != null && word) return `~${fmtPacks(row.on_hand_packs)} ${word}`;
  return `~${fmtQty(row.on_hand_qty)} ${row.base_unit ?? ""}`.trim();
}

/** Status chip colours shared by the invoice list and review header. */
export function statusChipClass(status: string): string {
  switch (status) {
    case "posted":
      return "bg-emerald-100 text-emerald-900";
    case "needs_review":
      return "bg-amber-100 text-amber-900";
    case "rejected":
      return "bg-red-100 text-red-900";
    case "parsing":
      return "bg-sky-100 text-sky-900";
    default:
      return "bg-neutral-200 text-neutral-800";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "needs_review":
      return "needs review";
    default:
      return status;
  }
}

export function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

/** The ?ok= / ?error= banner used on every page that has server actions. */
export function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  return (
    <>
      {typeof ok === "string" ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{ok}</p> : null}
      {typeof error === "string" ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
    </>
  );
}

/** "Fri 8:40 pm" (this week) or "Sep 4, 8:40 pm" in the location's timezone — for "86'd since …". */
export function fmtSince(iso: string | null | undefined, timezone: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(d).toLowerCase();
  const withinWeek = now.getTime() - d.getTime() < 6 * 86_400_000;
  const day = new Intl.DateTimeFormat("en-US", withinWeek ? { timeZone: timezone, weekday: "short" } : { timeZone: timezone, month: "short", day: "numeric" }).format(d);
  return `${day} ${time}`;
}
