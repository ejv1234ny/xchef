import Decimal from "decimal.js";
import {
  fixed4,
  isCountUom,
  isMassUom,
  isVolumeUom,
  parseTextUnit,
  textUnitLabel,
  textUnitToBase,
  type TextUnit,
  type Uom,
} from "./units";

/**
 * Pack-size parsing (pure, no I/O). CLAUDE.md rule 4: never hardcode a pack
 * size. `DEFAULT_PACKS` is a table of *defaults* for formats whose size is not
 * printed on the invoice (#10 can, keg, "fifth"). A size parsed from the text
 * ALWAYS beats a default; the owner's edit on vendor_item_mappings beats both
 * (that precedence lives in resolveMapping.ts). Every result carries
 * `assumed_text` so the UI can show the assumed base units per pack.
 *
 * Result semantics: a pack = `units_per_pack` × `base_units_per_unit` base
 * units. "6/#10" against oz → 6 × 106 oz. "40 LB" against lb → 1 × 40 lb.
 */
export type PackParse = {
  units_per_pack: string;
  base_units_per_unit: string | null;
  source: "parsed" | "default" | "unknown";
  assumed_text: string;
  range?: { min: string; max: string };
};

export type PackDefault = {
  /** stable id used as the default's key */
  id: string;
  label: string;
  /** size of ONE unit in `unit` */
  size: string;
  unit: TextUnit;
  assumed_text: string;
  /** products vary (#10 cans especially) — shown so a wrong constant is visible */
  range?: { min: string; max: string };
};

/** Defaults only. Parsed sizes override; owner's mapping overrides both. */
export const DEFAULT_PACKS: Record<string, PackDefault> = {
  "#10": { id: "#10", label: "#10 can", size: "106", unit: "oz", assumed_text: "#10 can ≈ 106 oz (102–128, assumed)", range: { min: "102", max: "128" } },
  "#5": { id: "#5", label: "#5 can", size: "56", unit: "oz", assumed_text: "#5 can ≈ 56 oz (50–58, assumed)", range: { min: "50", max: "58" } },
  "#2.5": { id: "#2.5", label: "#2.5 can", size: "29", unit: "oz", assumed_text: "#2.5 can ≈ 29 oz (28–30, assumed)", range: { min: "28", max: "30" } },
  "#303": { id: "#303", label: "#303 can", size: "16", unit: "oz", assumed_text: "#303 can ≈ 16 oz (15–17, assumed)", range: { min: "15", max: "17" } },
  "#300": { id: "#300", label: "#300 can", size: "15", unit: "oz", assumed_text: "#300 can ≈ 15 oz (14–16, assumed)", range: { min: "14", max: "16" } },
  "1/6 bbl": { id: "1/6 bbl", label: "1/6 bbl keg", size: "661", unit: "oz", assumed_text: "sixth-barrel keg ≈ 661 oz (5.16 gal, assumed)" },
  "1/4 bbl": { id: "1/4 bbl", label: "1/4 bbl keg", size: "992", unit: "oz", assumed_text: "quarter-barrel keg ≈ 992 oz (7.75 gal, assumed)" },
  "1/2 bbl": { id: "1/2 bbl", label: "1/2 bbl keg", size: "1984", unit: "oz", assumed_text: "half-barrel keg ≈ 1984 oz (15.5 gal, assumed)" },
  "750ml": { id: "750ml", label: "750 ml bottle", size: "750", unit: "ml", assumed_text: "750 ml bottle (fifth) = 25.3605 oz (assumed)" },
  "1l": { id: "1l", label: "1 L bottle", size: "1000", unit: "ml", assumed_text: "1 L bottle = 33.814 oz (assumed)" },
  "1.75l": { id: "1.75l", label: "1.75 L bottle", size: "1750", unit: "ml", assumed_text: "1.75 L handle = 59.1745 oz (assumed)" },
  "12oz can": { id: "12oz can", label: "12 oz can", size: "12", unit: "oz", assumed_text: "12 oz can (assumed)" },
  "16oz can": { id: "16oz can", label: "16 oz can", size: "16", unit: "oz", assumed_text: "16 oz can (assumed)" },
};

/**
 * Words on invoices that name a default format without printing its size.
 * "1/6" alone is a keg; "1/2" and "1/4" need the keg word (they could be a half gallon).
 */
const DEFAULT_WORDS: Array<{ re: RegExp; id: string }> = [
  { re: /^(?:1\/6|SIXTH|1\/6TH)\s*(?:BBL|BARREL|KEG)?$/i, id: "1/6 bbl" },
  { re: /^(?:1\/4|QUARTER|1\/4TH)\s*(?:BBL|BARREL|KEG)$/i, id: "1/4 bbl" },
  { re: /^(?:1\/2|HALF)\s*(?:BBL|BARREL|KEG)$/i, id: "1/2 bbl" },
  { re: /^(?:FIFTH)$/i, id: "750ml" },
  { re: /^(?:LITER|LITRE|LTR)$/i, id: "1l" },
  { re: /^(?:HANDLE)$/i, id: "1.75l" },
  { re: /^(?:12\s*OZ\s*CANS?|CANS?\s*12\s*OZ)$/i, id: "12oz can" },
  { re: /^(?:16\s*OZ\s*CANS?|CANS?\s*16\s*OZ|TALL\s*BOYS?)$/i, id: "16oz can" },
];
const KEG_WORD = /BBL|BARREL|KEG|FIFTH|LITER|LITRE|LTR|HANDLE|CAN/i;

const CASE_WORDS = /^(?:CS|CASE|BX|BOX|BAG|BG|PAIL|PL|TUB|JUG|DRUM|CTN|CARTON|PK|PACK|PKG|SLEEVE|FLAT|C|U)$/i;
const EACH_WORDS = /^(?:EA|EACH|UNIT|PC|PCS|PIECE|CT)$/i;
/** trailing container words that don't change the size: "50 LB BAG", "5 GAL PAIL" */
const TRAILING_CONTAINER = /\s+(?:BAG|BG|BOX|BX|CS|CASE|JUG|BTL|BOTTLE|BTLS|BOTTLES|CAN|CANS|PAIL|TUB|SACK|DRUM|CTN|CARTON|PKG|PK|PACK|LOOSE|AVG|AV|NET)\s*$/i;

const NUM = "(\\d+(?:\\.\\d+)?)";
const UNIT = "([A-Z#.]+(?:\\s*OZ)?)"; // "FL OZ", "LB", "#", "Z"

type Size = { value: Decimal; unit: TextUnit; raw: string };

function fmtSize(size: Size, baseUnit: Uom): string {
  return `${size.value.toString()} ${textUnitLabel(size.unit, baseUnit)}`;
}

function unknown(assumed_text: string, units: Decimal = new Decimal(1)): PackParse {
  return { units_per_pack: fixed4(units), base_units_per_unit: null, source: "unknown", assumed_text };
}

function isVolumeText(u: TextUnit): boolean {
  return u === "gal" || u === "qt" || u === "pt" || u === "floz" || u === "oz" || u === "ml" || u === "l";
}

function mismatch(units: Decimal, size: Size, baseUnit: Uom): PackParse {
  const kind = isVolumeUom(baseUnit) ? "a volume" : isMassUom(baseUnit) ? "a weight" : "a count";
  const sizeKind = size.unit === "each" ? "a count" : isVolumeText(size.unit) ? "a volume" : "a weight";
  return unknown(
    `${units.toString()} × ${fmtSize(size, baseUnit)} is ${sizeKind}, but the item is tracked in ${baseUnit} (${kind}) — set the pack size on the mapping`,
    units,
  );
}

function countOnly(units: Decimal, baseUnit: Uom, source: PackParse["source"] = "parsed"): PackParse {
  if (isCountUom(baseUnit)) {
    return { units_per_pack: fixed4(units), base_units_per_unit: fixed4(new Decimal(1)), source, assumed_text: `${units.toString()} × 1 ${baseUnit}` };
  }
  return unknown(`${units.toString()} count — size per piece not on invoice (item tracked in ${baseUnit})`, units);
}

/** units × a size parsed from text → PackParse (source 'parsed'), or a mismatch. */
function fromParsedSize(units: Decimal, size: Size, baseUnit: Uom): PackParse {
  if (isCountUom(baseUnit)) {
    // "12/750ML" against base `bottle`: each unit IS one base unit.
    return {
      units_per_pack: fixed4(units),
      base_units_per_unit: fixed4(new Decimal(1)),
      source: "parsed",
      assumed_text: `${units.toString()} × ${fmtSize(size, baseUnit)} — counted as 1 ${baseUnit} each`,
    };
  }
  const factor = textUnitToBase(size.unit, baseUnit);
  if (!factor) return mismatch(units, size, baseUnit);
  const per = size.value.times(factor);
  return {
    units_per_pack: fixed4(units),
    base_units_per_unit: fixed4(per),
    source: "parsed",
    assumed_text: `${units.toString()} × ${fmtSize(size, baseUnit)} = ${fixed4(per)} ${baseUnit} each`,
  };
}

/** units × a default format → PackParse (source 'default'), with range when the format varies. */
function fromDefault(units: Decimal, def: PackDefault, baseUnit: Uom): PackParse {
  if (isCountUom(baseUnit)) {
    return {
      units_per_pack: fixed4(units),
      base_units_per_unit: fixed4(new Decimal(1)),
      source: "default",
      assumed_text: `${units.toString()} × ${def.label} — counted as 1 ${baseUnit} each`,
    };
  }
  const factor = textUnitToBase(def.unit, baseUnit);
  if (!factor) return mismatch(units, { value: new Decimal(def.size), unit: def.unit, raw: def.label }, baseUnit);
  const per = new Decimal(def.size).times(factor);
  const out: PackParse = {
    units_per_pack: fixed4(units),
    base_units_per_unit: fixed4(per),
    source: "default",
    assumed_text: `${units.toString()} × ${def.assumed_text}`,
  };
  if (def.range) {
    out.range = { min: fixed4(new Decimal(def.range.min).times(factor)), max: fixed4(new Decimal(def.range.max).times(factor)) };
  }
  return out;
}

function parseSizeToken(value: string, unitToken: string): Size | null {
  const unit = parseTextUnit(unitToken);
  if (!unit) return null;
  return { value: new Decimal(value), unit, raw: `${value}${unitToken}` };
}

/**
 * Normalize invoice / receipt pack text for matching:
 *  - uppercase, collapse whitespace, "×" → "/"
 *  - drop price tails ("13.21 LB @ $6.49/LB" → "13.21 LB") and "· notes"
 *  - drop Restaurant Depot flags like "(TA)" (tax applies)
 *  - close up "6 / 750 ML" → "6/750 ML" and "6 X 750" → "6X750"
 */
export function normalizePackText(raw: string): string {
  let s = raw.toUpperCase().replace(/×/g, "/").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*@.*$/, "").replace(/·/g, " ");
  s = s.replace(/\(TA\)/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\/\s*/g, "/").replace(/(\d)\s*X\s*(\d)/g, "$1X$2");
  return s.trim();
}

/**
 * Parse pack-size text from an invoice line into units per pack and base units
 * per unit for a given base unit. Case-insensitive, whitespace-tolerant.
 *
 *   "6/#10"     oz → 6 × 106 (default, range 102–128)
 *   "3/114OZ"   oz → 3 × 114 (parsed)
 *   "12/750ML"  oz → 12 × 25.3605 (parsed)
 *   "40 LB"     lb → 1 × 40
 *   "40 LB"     oz → unknown (weight vs volume)
 *   "CS"        *  → unknown, "case (size unknown)"
 *   "1/6 BBL"   oz → 1 × 661 (default)
 */
export function parsePackSize(text: string | null | undefined, baseUnit: Uom): PackParse {
  const raw = (text ?? "").trim();
  if (!raw) return unknown("pack size not on invoice (size unknown)");
  const s = normalizePackText(raw);
  if (!s) return unknown(`"${raw}" — could not read a pack size (size unknown)`);
  const stripped = s.replace(TRAILING_CONTAINER, "").trim();

  // 1. kegs and other named defaults, optionally with a leading count: "1/6 BBL", "2/1/6 BBL", "FIFTH"
  for (const d of DEFAULT_WORDS) {
    if (d.re.test(stripped)) return fromDefault(new Decimal(1), DEFAULT_PACKS[d.id], baseUnit);
    const m = stripped.match(/^(\d+)\/(.+)$/);
    if (m && d.re.test(m[2]) && KEG_WORD.test(m[2])) return fromDefault(new Decimal(m[1]), DEFAULT_PACKS[d.id], baseUnit);
  }

  // 2. can numbers: "6/#10", "#10", "6 / #10 CAN", "#300"
  {
    const m = stripped.match(/^(?:(\d+(?:\.\d+)?)\/)?#\s*(10|5|2\.5|303|300)\b/);
    if (m) {
      const def = DEFAULT_PACKS[`#${m[2]}`];
      if (def) return fromDefault(new Decimal(m[1] ?? "1"), def, baseUnit);
    }
  }

  // 3. fractions of a unit: "1/2 GAL", "1/4 LB" (only 1/N with small N; "2/5LB" is 2 × 5 lb, below)
  {
    const m = stripped.match(new RegExp(`^1/([2-9])\\s*${UNIT}$`));
    if (m) {
      const size = parseSizeToken("1", m[2]);
      if (size && size.unit !== "each") {
        size.value = new Decimal(1).div(m[1]);
        size.raw = `1/${m[1]} ${m[2]}`;
        return fromParsedSize(new Decimal(1), size, baseUnit);
      }
    }
  }

  // 4. count / size unit: "6/750ML", "24/12OZ", "2/5LB", "4/1GAL", "3/114OZ", "4/2.5#", "6X750ML", "12-1L", "20/1LB"
  {
    const m = stripped.match(new RegExp(`^${NUM}\\s*[/X\\-]\\s*${NUM}\\s*${UNIT}$`));
    if (m) {
      const size = parseSizeToken(m[2], m[3]);
      if (size) {
        if (size.unit === "each") return countOnly(new Decimal(m[1]).times(m[2]), baseUnit);
        return fromParsedSize(new Decimal(m[1]), size, baseUnit);
      }
    }
  }

  // 5. size unit alone (with optional trailing container word): "40 LB", "750ML", "50 LB BAG", "5# BAG", "1.5 GAL JUG"
  {
    const m = stripped.match(new RegExp(`^${NUM}\\s*${UNIT}$`));
    if (m) {
      const size = parseSizeToken(m[1], m[2]);
      if (size) {
        if (size.unit === "each") return countOnly(size.value, baseUnit); // "24 CT" / "12 EA": a count, not a size
        return fromParsedSize(new Decimal(1), size, baseUnit);
      }
    }
  }

  // 6. Restaurant Depot receipt forms: "C 1CS/7U" (a case of 7 units), "CASE $15.00/12", "2X U", "8PK", "24CT BOX"
  {
    let m = stripped.match(/(\d+)\s*CS\/(\d+)\s*U\b/);
    if (m) return countOnly(new Decimal(m[2]).div(m[1]), baseUnit);
    m = stripped.match(/CASE\s*\$[\d,.]+\/(\d+)/);
    if (m) return countOnly(new Decimal(m[1]), baseUnit);
    m = stripped.match(/^(\d+)\s*X?\s*(?:U|CT|PK|PACK|EA|EACH)\b/);
    if (m) return countOnly(new Decimal(m[1]), baseUnit);
  }

  // 7. bare unit words: "EA", "EACH", "CS", "CASE", "BOX", "BAG", "C", "U"
  if (EACH_WORDS.test(stripped) || EACH_WORDS.test(s)) {
    if (isCountUom(baseUnit)) return countOnly(new Decimal(1), baseUnit);
    return unknown(`each — size per piece not on invoice (item tracked in ${baseUnit})`);
  }
  if (CASE_WORDS.test(stripped) || CASE_WORDS.test(s)) {
    if (/^(?:BAG|BG)$/i.test(stripped)) return unknown("bag (size unknown)");
    if (/^(?:BX|BOX)$/i.test(stripped)) return unknown("box (size unknown)");
    return unknown("case (size unknown)");
  }

  return unknown(`"${raw}" — could not read a pack size (size unknown)`);
}

/** Look up a default by id ("#10", "1/6 bbl", "750ml"). */
export function defaultPack(id: string, baseUnit: Uom, units = 1): PackParse | null {
  const def = DEFAULT_PACKS[id];
  return def ? fromDefault(new Decimal(units), def, baseUnit) : null;
}
