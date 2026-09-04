import { Constants, type Enums } from "@/lib/db/types";

/** Unit-of-measure enum values, in the order the DB declares them. */
export const UOMS = Constants.public.Enums.uom;
export type Uom = Enums<"uom">;

/** Inventory categories offered in the catalog form (mirrors the drafter's list). */
export const INVENTORY_CATEGORY_OPTIONS = [
  "liquor",
  "beer",
  "wine",
  "na_bev",
  "produce",
  "protein",
  "dairy",
  "dry",
  "frozen",
  "paper",
  "other",
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  liquor: "Liquor",
  beer: "Beer",
  wine: "Wine",
  na_bev: "N/A beverages",
  produce: "Produce",
  protein: "Proteins",
  dairy: "Dairy",
  dry: "Dry goods",
  frozen: "Frozen",
  paper: "Paper & disposables",
  other: "Other",
};

export function categoryLabel(c: string | null | undefined): string {
  if (!c) return "Uncategorized";
  return CATEGORY_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "$186.40"; empty string for null. Display only, never fed back into math. */
export function fmtMoney(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "$0.2140" for per-base-unit costs that need more precision. */
export function fmtUnitCost(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/** Quantity in base units: "108.0", "0.38". */
export function fmtQty(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

/** Units sold: "72", "12.5". */
export function fmtCount(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** cost_pct fraction (0.31) → "31%". */
export function fmtPct(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "";
  return `${Math.round(n * 100)}%`;
}

/** Editable numeric value as the raw string the DB returned; nothing is rounded. */
export function rawNumeric(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

export function StatusChip({ status }: { status: Enums<"recipe_status"> | null | undefined }) {
  const map: Record<Enums<"recipe_status">, { label: string; cls: string }> = {
    draft: { label: "no recipe", cls: "bg-neutral-100 text-neutral-600" },
    needs_review: { label: "needs review", cls: "bg-amber-100 text-amber-900" },
    confirmed: { label: "confirmed", cls: "bg-emerald-100 text-emerald-900" },
  };
  const s = map[status ?? "draft"];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export function ConfidenceChip({ confidence }: { confidence: number | string | null | undefined }) {
  const n = num(confidence) ?? 0;
  const pct = Math.round(Math.min(1, Math.max(0, n)) * 100);
  const cls = pct >= 80 ? "bg-emerald-100 text-emerald-900" : pct >= 50 ? "bg-amber-100 text-amber-900" : "bg-red-100 text-red-800";
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>AI {pct}% sure</span>;
}

export function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  return (
    <>
      {typeof ok === "string" ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{ok}</p> : null}
      {typeof error === "string" ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
    </>
  );
}
