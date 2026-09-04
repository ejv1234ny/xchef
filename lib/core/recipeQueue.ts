/**
 * Recipe Q&A queue ordering (architecture §4.2): units sold in the last 30
 * days × (1 − best confidence among unconfirmed components). Pure; no I/O.
 */
export type RecipeQueueComponent = {
  id: string;
  confidence: string | number | null;
  source: string;
};

export type RecipeQueueRow = {
  menu_item_id: string;
  units_sold_30d: string | number;
  components: RecipeQueueComponent[];
  /** optional, used only to break ties deterministically before falling back to id */
  name?: string | null;
};

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Score a single row; null when nothing on it is left to confirm. Null confidence counts as 0. */
export function recipeQueueScore(row: RecipeQueueRow): { score: number; units: number; best: number } | null {
  const open = row.components.filter((c) => c.source !== "confirmed");
  if (open.length === 0) return null;
  const best = Math.max(...open.map((c) => Math.min(1, Math.max(0, toNum(c.confidence)))));
  const units = Math.max(0, toNum(row.units_sold_30d));
  return { score: units * (1 - best), units, best };
}

/**
 * Menu item ids ordered highest priority first. Items with no sales in the
 * window go last (still queued, least-confident first). Items whose
 * components are all confirmed are excluded. Ties break by name, then id.
 */
export function orderRecipeQueue(rows: RecipeQueueRow[]): string[] {
  const scored: Array<{ id: string; name: string; score: number; units: number; best: number }> = [];
  for (const row of rows) {
    const s = recipeQueueScore(row);
    if (!s) continue;
    scored.push({ id: row.menu_item_id, name: (row.name ?? "").toLowerCase(), ...s });
  }
  scored.sort((a, b) => {
    const aNoSales = a.units > 0 ? 0 : 1;
    const bNoSales = b.units > 0 ? 0 : 1;
    if (aNoSales !== bNoSales) return aNoSales - bNoSales;
    if (b.score !== a.score) return b.score - a.score;
    if (a.best !== b.best) return a.best - b.best;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored.map((s) => s.id);
}
