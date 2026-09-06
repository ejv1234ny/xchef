/**
 * Deterministic "is this line the same product as an item we already have?"
 * guard (KICKOFF-3 item 3). The recipe drafter creates ingredients before any
 * invoice mentions them ("Tito's Handmade Vodka", "Coke (Fountain or Bottle)");
 * when the first invoice line for that product arrives, the line must land on
 * the draft-born item instead of creating a duplicate. Pure, no I/O.
 *
 * Rule: tokenize both sides (lowercase, possessives and punctuation dropped,
 * pack / size / packaging words dropped, a few ticket abbreviations expanded);
 * a candidate matches when every line token is in the candidate (or every
 * candidate token is in the line — a brand word in front of a product we
 * stock), the line covers at least 60% of the candidate's words (or vice
 * versa), qualifiers (diet, zero, reposado, …) agree on both sides, and the
 * candidate is the unique best by overlap.
 */
export type NameCandidate = { id: string; name: string };

const STOPWORDS = new Set([
  "or", "and", "the", "of", "a", "an", "w", "with", "in", "per", "each", "ea", "ct", "cs", "case", "cases", "pk", "pack", "packs", "pkg",
  "btl", "btls", "bottle", "bottles", "can", "cans", "bag", "bags", "box", "boxes", "bib", "keg", "kegs", "jug", "jugs", "pail", "tub",
  "gal", "gallon", "gallons", "oz", "floz", "fl", "ml", "l", "lb", "lbs", "kg", "g", "qt", "pt", "ltr", "liter", "litre",
  "fountain", "housemade", "premix", "pre", "mix", "handmade", "brand", "item", "product", "full", "single", "singles",
  "frz", "frozen", "fresh", "loose", "bulk", "iqf", "avg", "net",
]);

/** Qualifiers that change the product: a candidate carrying one must see it in the line. */
const QUALIFIERS = new Set([
  "diet", "zero", "light", "lite", "decaf", "unsweetened", "sweetened", "sugarfree",
  "blanco", "silver", "plata", "reposado", "anejo", "añejo", "gold", "white", "dark", "spiced", "black", "red", "green",
  "dry", "sweet", "extra", "premium", "well", "house", "organic", "mini", "large", "small", "jumbo",
]);

/** Ticket / receipt abbreviations, applied token by token (two-token forms handled first). */
const ABBREVIATIONS: Record<string, string> = {
  dt: "diet", dc: "diet coke", zr: "zero", sprt: "sprite", spr: "sprite", crnbry: "cranberry", cranb: "cranberry",
  lmnd: "lemonade", lmnt: "lemonade", lmnde: "lemonade", orng: "orange", oj: "orange juice", grpfrt: "grapefruit",
  ging: "ginger", gngr: "ginger", seag: "seagrams", seagram: "seagrams", cc: "coke", cola: "coke", cocacola: "coke",
  vod: "vodka", vdka: "vodka", whsky: "whiskey", whisky: "whiskey", bourb: "bourbon", teq: "tequila", tq: "tequila",
  chix: "chicken", chkn: "chicken", chk: "chicken", brst: "breast", grnd: "ground", bf: "beef", chs: "cheese", ched: "cheddar",
  tom: "tomato", toms: "tomatoes", lett: "lettuce", rom: "romaine", ons: "onions", pep: "pepper", ptato: "potato",
  ff: "fries", mayo: "mayonnaise", ketch: "ketchup", must: "mustard", dsg: "dressing",
};
const TWO_TOKEN: Array<[RegExp, string]> = [
  [/\bg ale\b/g, "ginger ale"],
  [/\bgin ale\b/g, "ginger ale"],
  [/\bdt coke\b/g, "diet coke"],
  [/\bice tea\b/g, "iced tea"],
  [/\bmm\b/g, "minute maid"],
];

const SIZE_TOKEN = /^\d|^#\d|^\d+(\.\d+)?(g|gal|gbib|ml|l|oz|z|lb|ct|pk|x)$/i;
const SINGULAR = (t: string) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

export function nameTokens(name: string): string[] {
  let s = name.toLowerCase().replace(/'s\b/g, "s").replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9#.\s]/g, " ");
  for (const [re, rep] of TWO_TOKEN) s = s.replace(re, rep);
  const out = new Set<string>();
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue;
    const t = raw.replace(/\.$/, "");
    if (SIZE_TOKEN.test(t)) continue;
    const expanded = ABBREVIATIONS[t] ?? t;
    for (const e of expanded.split(" ")) {
      const w = SINGULAR(e);
      if (!w || STOPWORDS.has(w) || STOPWORDS.has(e)) continue;
      out.add(w);
    }
  }
  return [...out];
}

export type NameMatch = { id: string; name: string; score: number; reason: string };

/** One side must cover at least this share of the other's tokens ("VODKA" alone never claims "Tito's Vodka"; "TOMATO PASTE" never claims "Tomatoes"). */
export const MIN_NAME_MATCH_SCORE = 0.6;

/**
 * Best existing item for a line (and, optionally, the name the matcher
 * proposed for a new item). Null when nothing qualifies or the best is tied.
 */
export function findNameMatch(inputs: Array<string | null | undefined>, candidates: NameCandidate[]): NameMatch | null {
  const lineTokenSets = inputs.filter((s): s is string => Boolean(s && s.trim())).map(nameTokens).filter((t) => t.length > 0);
  if (lineTokenSets.length === 0) return null;
  const best = new Map<string, NameMatch>();
  for (const c of candidates) {
    const ct = nameTokens(c.name);
    if (ct.length === 0) continue;
    const cset = new Set(ct);
    for (const lt of lineTokenSets) {
      const lset = new Set(lt);
      const lineInCandidate = lt.every((t) => cset.has(t));
      // the reverse also counts: "SEAG G ALE" contains every word of "Ginger Ale" (a brand in front of a product we stock)
      const candidateInLine = ct.every((t) => lset.has(t));
      if (!lineInCandidate && !candidateInLine) continue;
      // a qualifier on either side must appear on the other (Diet Coke ≠ Coke, Coke Zero ≠ Coke)
      if (ct.some((t) => QUALIFIERS.has(t) && !lset.has(t))) continue;
      if (lt.some((t) => QUALIFIERS.has(t) && !cset.has(t))) continue;
      const score = lineInCandidate ? lt.length / ct.length : ct.length / lt.length;
      if (score < MIN_NAME_MATCH_SCORE) continue;
      const prev = best.get(c.id);
      if (!prev || prev.score < score) best.set(c.id, { id: c.id, name: c.name, score, reason: `"${lt.join(" ")}" is contained in "${ct.join(" ")}"` });
    }
  }
  if (best.size === 0) return null;
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  const top = ranked[0];
  return { ...top, score: Number(top.score.toFixed(4)) };
}
