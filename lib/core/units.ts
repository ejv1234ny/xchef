import Decimal from "decimal.js";

/**
 * Unit math (pure, no I/O). Mirrors SQL `convert_factor()` in docs/schema.sql:
 * volume units are related through ml (oz = 29.5735 ml), mass units through g
 * (lb = 453.592 g). Where SQL returns 1 for incompatible units (so recipes are
 * assumed to be authored in the base unit), this module returns `null` so the
 * caller can say "size unknown" instead of silently treating 40 lb as 40 oz.
 *
 * Two vocabularies:
 *  - `Uom` — the Postgres enum: what inventory_items.base_unit can be.
 *  - `TextUnit` — units as printed on invoices ("GAL", "QT", "#", "Z"…). These
 *    only ever convert *into* a Uom via `textUnitToBase`.
 */
export type Uom = "oz" | "ml" | "l" | "g" | "kg" | "lb" | "each" | "case" | "bottle" | "can";

export const UOMS: readonly Uom[] = ["oz", "ml", "l", "g", "kg", "lb", "each", "case", "bottle", "can"];

export function isUom(s: string): s is Uom {
  return (UOMS as readonly string[]).includes(s);
}

/** Volume units → millilitres. `gal`/`qt`/`pt` are defined as exact multiples of the fluid ounce. */
const VOLUME_ML: Record<string, Decimal> = {
  oz: new Decimal("29.5735"),
  floz: new Decimal("29.5735"),
  ml: new Decimal(1),
  l: new Decimal(1000),
  gal: new Decimal("29.5735").times(128),
  qt: new Decimal("29.5735").times(32),
  pt: new Decimal("29.5735").times(16),
};

/** Mass units → grams. `ozwt` is the avoirdupois (weight) ounce. */
const MASS_G: Record<string, Decimal> = {
  g: new Decimal(1),
  kg: new Decimal(1000),
  lb: new Decimal("453.592"),
  ozwt: new Decimal("28.3495"),
};

const COUNT_UNITS: ReadonlySet<string> = new Set(["each", "case", "bottle", "can"]);

export function isVolumeUom(u: Uom): boolean {
  return u === "oz" || u === "ml" || u === "l";
}
export function isMassUom(u: Uom): boolean {
  return u === "g" || u === "kg" || u === "lb";
}
export function isCountUom(u: Uom): boolean {
  return COUNT_UNITS.has(u);
}

/**
 * Multiply a quantity in `from` by this to get `to`. Same as SQL convert_factor
 * except incompatible pairs (oz → lb, case → oz, each → bottle) return null.
 */
export function convertFactor(from: Uom, to: Uom): Decimal | null {
  if (from === to) return new Decimal(1);
  if (VOLUME_ML[from] && VOLUME_ML[to]) return VOLUME_ML[from].div(VOLUME_ML[to]);
  if (MASS_G[from] && MASS_G[to]) return MASS_G[from].div(MASS_G[to]);
  return null;
}

/**
 * Units as they appear on invoices / labels. `oz` is ambiguous on paper: it is
 * a fluid ounce when the target base unit is a volume and a weight ounce when
 * the target is a mass. `textUnitToBase` resolves that per call.
 */
export type TextUnit = "gal" | "qt" | "pt" | "floz" | "oz" | "ml" | "l" | "lb" | "kg" | "g" | "ozwt" | "each";

/** Normalize a unit token from invoice text ("LBS", "#", "Z", "FL OZ", "CT"…) to a TextUnit, or null. */
export function parseTextUnit(token: string): TextUnit | null {
  const t = token.trim().toLowerCase().replace(/\s+/g, "").replace(/\.$/, "");
  switch (t) {
    case "gal":
    case "gl":
    case "gallon":
    case "gallons":
      return "gal";
    case "qt":
    case "qts":
    case "quart":
    case "quarts":
      return "qt";
    case "pt":
    case "pts":
    case "pint":
    case "pints":
      return "pt";
    case "floz":
    case "fl.oz":
    case "fluidoz":
    case "fluidounce":
      return "floz";
    case "oz":
    case "z":
    case "ozs":
    case "ounce":
    case "ounces":
      return "oz";
    case "ml":
    case "mls":
    case "milliliter":
    case "millilitre":
      return "ml";
    case "l":
    case "lt":
    case "ltr":
    case "liter":
    case "litre":
    case "liters":
    case "litres":
      return "l";
    case "lb":
    case "lbs":
    case "#":
    case "pound":
    case "pounds":
      return "lb";
    case "kg":
    case "kgs":
    case "kilo":
    case "kilogram":
      return "kg";
    case "g":
    case "gr":
    case "gm":
    case "gram":
    case "grams":
      return "g";
    case "ea":
    case "each":
    case "ct":
    case "cnt":
    case "count":
    case "pc":
    case "pcs":
    case "piece":
    case "pieces":
    case "unit":
    case "units":
      return "each";
    default:
      return null;
  }
}

/**
 * Factor from one *text* unit into a base Uom, or null when incompatible.
 *   textUnitToBase('gal', 'oz')  → 128
 *   textUnitToBase('ml', 'oz')   → 0.03381…
 *   textUnitToBase('oz', 'lb')   → 0.0625   (weight ounce)
 *   textUnitToBase('lb', 'oz')   → null     (mass vs volume)
 *   textUnitToBase('each', 'each') → 1
 * For count base units (each/case/bottle/can) only `each` converts (factor 1):
 * a "750ML" bottle against base `bottle` is one bottle, which the caller decides.
 */
export function textUnitToBase(unit: TextUnit, baseUnit: Uom): Decimal | null {
  if (isCountUom(baseUnit)) return unit === "each" ? new Decimal(1) : null;
  if (unit === "each") return null;
  if (isVolumeUom(baseUnit)) {
    const key = unit === "ozwt" ? null : unit;
    const from = key ? VOLUME_ML[key] : undefined;
    if (!from) return null;
    return from.div(VOLUME_ML[baseUnit]);
  }
  if (isMassUom(baseUnit)) {
    const key = unit === "oz" ? "ozwt" : unit;
    const from = MASS_G[key];
    if (!from) return null;
    return from.div(MASS_G[baseUnit]);
  }
  return null;
}

/** Human label for a text unit in its base context ("fl oz" vs "oz wt"). */
export function textUnitLabel(unit: TextUnit, baseUnit: Uom): string {
  if (unit === "oz" || unit === "floz") return isMassUom(baseUnit) ? "oz wt" : "fl oz";
  if (unit === "ozwt") return "oz wt";
  return unit;
}

/** numeric(14,4) canonical string */
export function fixed4(d: Decimal): string {
  return d.toFixed(4);
}
/** numeric(12,6) canonical string */
export function fixed6(d: Decimal): string {
  return d.toFixed(6);
}
