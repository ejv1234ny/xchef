import { describe, expect, it } from "vitest";
import { orderRecipeQueue, recipeQueueScore, type RecipeQueueRow } from "./recipeQueue";

const rows: RecipeQueueRow[] = [
  // 72 sold × (1 − 0.9) = 7.2
  {
    menu_item_id: "margarita",
    name: "Classic Margarita",
    units_sold_30d: "72",
    components: [
      { id: "c1", confidence: "0.90", source: "ai_draft" },
      { id: "c2", confidence: "0.40", source: "ai_draft" },
    ],
  },
  // all confirmed → excluded
  {
    menu_item_id: "moose-burger",
    name: "Moose Burger",
    units_sold_30d: 500,
    components: [
      { id: "c3", confidence: "0.95", source: "confirmed" },
      { id: "c4", confidence: null, source: "confirmed" },
    ],
  },
  // null confidence → 0 → 30 × 1 = 30 (top)
  {
    menu_item_id: "side-ranch",
    name: "Side Ranch",
    units_sold_30d: 30,
    components: [{ id: "c5", confidence: null, source: "ai_draft" }],
  },
  // tie with margarita: 12 × (1 − 0.4) = 7.2; same best confidence? no: 0.4 < 0.9 → less confident sorts first
  {
    menu_item_id: "wings",
    name: "Wings",
    units_sold_30d: "12",
    components: [{ id: "c6", confidence: 0.4, source: "ai_draft" }],
  },
  // exact tie with margarita on score and confidence → name "Aperol Spritz" < "Classic Margarita"
  {
    menu_item_id: "spritz",
    name: "Aperol Spritz",
    units_sold_30d: 72,
    components: [{ id: "c7", confidence: 0.9, source: "reverse_engineered" }],
  },
  // no sales → last
  {
    menu_item_id: "seasonal-special",
    name: "Seasonal Special",
    units_sold_30d: 0,
    components: [{ id: "c8", confidence: 0.2, source: "ai_draft" }],
  },
];

describe("recipeQueueScore", () => {
  it("uses the best unconfirmed confidence and treats null as 0", () => {
    expect(recipeQueueScore(rows[0]!)).toEqual({ score: 72 * (1 - 0.9), units: 72, best: 0.9 });
    expect(recipeQueueScore(rows[2]!)).toEqual({ score: 30, units: 30, best: 0 });
  });
  it("returns null when every component is confirmed", () => {
    expect(recipeQueueScore(rows[1]!)).toBeNull();
  });
  it("ignores confirmed components when picking the best confidence", () => {
    const r = recipeQueueScore({
      menu_item_id: "x",
      units_sold_30d: 10,
      components: [
        { id: "a", confidence: 0.99, source: "confirmed" },
        { id: "b", confidence: 0.5, source: "ai_draft" },
      ],
    });
    expect(r).toEqual({ score: 5, units: 10, best: 0.5 });
  });
});

describe("orderRecipeQueue", () => {
  it("orders by units × (1 − confidence), excludes confirmed items, puts no-sales items last and breaks ties by confidence then name", () => {
    expect(orderRecipeQueue(rows)).toEqual(["side-ranch", "wings", "spritz", "margarita", "seasonal-special"]);
  });
  it("is stable on identical rows (falls back to id)", () => {
    const twins: RecipeQueueRow[] = [
      { menu_item_id: "b", name: "Same", units_sold_30d: 5, components: [{ id: "1", confidence: 0.5, source: "ai_draft" }] },
      { menu_item_id: "a", name: "Same", units_sold_30d: 5, components: [{ id: "2", confidence: 0.5, source: "ai_draft" }] },
    ];
    expect(orderRecipeQueue(twins)).toEqual(["a", "b"]);
  });
  it("returns an empty list when nothing needs confirming", () => {
    expect(orderRecipeQueue([rows[1]!])).toEqual([]);
    expect(orderRecipeQueue([])).toEqual([]);
  });
});
