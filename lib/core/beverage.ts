/**
 * Beverage-distributor tickets (Coca-Cola Beverages Northeast, Pepsi):
 * bag-in-box syrup is sold by the box and the size is written into the
 * product name as "2.5GBIB" / "5GBIB" / "2.5 GAL BIB", not in a pack column.
 * Pure helpers used by the map job when vendors.kind = 'beverage_distributor'.
 */
export type BibSize = { text: string; gallons: string } | null;

const BIB_RE = /(?:^|[\s(])(\d+(?:\.\d+)?)\s*(?:G|GAL|GALLON)?\s*BIB\b/i;
const BIB_SUFFIX_RE = /\bBIB\s*(\d+(?:\.\d+)?)\s*(?:G|GAL|GALLON)\b/i;

/** "2.5GBIB COKE" → { text: "2.5 GAL BIB", gallons: "2.5" }; null when the name carries no BIB size. */
export function inferBibSize(description: string): BibSize {
  const m = description.match(BIB_RE) ?? description.match(BIB_SUFFIX_RE);
  if (!m) return null;
  const gallons = m[1];
  return { text: `${gallons} GAL BIB`, gallons };
}

/** CO2 / nitrogen cylinders and tank rentals on a beverage ticket are gas, not inventory. */
export function isGasCylinderLine(description: string): boolean {
  return /\bCO2\b|\bCO₂\b|\bCYL(?:INDER)?\b|\bNITRO(?:GEN)?\s*TANK\b|\bN2\s*TANK\b/i.test(description);
}

/**
 * The parser appends the ticket's category family in brackets when a product
 * name is abbreviated ("2.5GBIB GP PRE-LMND T [TEA]"). When the name itself
 * cannot be matched, the family names the ingredient we stock.
 */
const FAMILY_HINTS: Array<[RegExp, string]> = [
  [/\[\s*TEA\s*\]/i, "iced tea"],
  [/\[\s*LEMONADE\s*\]/i, "lemonade"],
  [/\[\s*COFFEE\s*\]/i, "coffee"],
];
export function familyHint(description: string): string | null {
  for (const [re, hint] of FAMILY_HINTS) if (re.test(description)) return hint;
  return null;
}
