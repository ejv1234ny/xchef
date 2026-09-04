/**
 * Retail liquor receipts (vendors.kind = 'retail_liquor') print one line per
 * bottle/can/pack, usually with the size buried in the item name ("TITOS
 * VODKA 1.75L", "BUD LIGHT 12PK 12OZ CANS"). Infer a pack_size_text the pack
 * parser understands; default to 750 ml (assumed=true) when nothing is printed.
 */
export type BottleSize = { text: string; ml: number | null; assumed: boolean };

const ML_PER_OZ = 29.5735;

const SIZES: Array<{ re: RegExp; ml: number; text: string }> = [
  { re: /\b1\.75\s*L(?:T|TR|ITER)?\b|\b1750\s*ML\b|\b1\.75L\b/i, ml: 1750, text: "1.75L" },
  { re: /\b1\.5\s*L(?:T|TR)?\b|\b1500\s*ML\b/i, ml: 1500, text: "1.5L" },
  { re: /\b1\s*L(?:T|TR|ITER)?\b|\b1000\s*ML\b|\b1L\b/i, ml: 1000, text: "1L" },
  { re: /\b750\s*ML\b|\b750\b|\b\.75\s*L\b|\b75CL\b/i, ml: 750, text: "750ML" },
  { re: /\b375\s*ML\b|\b375\b/i, ml: 375, text: "375ML" },
  { re: /\b200\s*ML\b|\b200\b/i, ml: 200, text: "200ML" },
  { re: /\b100\s*ML\b/i, ml: 100, text: "100ML" },
  { re: /\b50\s*ML\b|\bMINI(?:ATURE)?S?\b|\bNIPS?\b/i, ml: 50, text: "50ML" },
  { re: /\b3\s*L(?:T|TR)?\b|\b3000\s*ML\b/i, ml: 3000, text: "3L" },
  { re: /\b5\s*L(?:T|TR)?\b|\b5000\s*ML\b/i, ml: 5000, text: "5L" },
];

/** "6PK 12OZ", "12 PK 12 OZ CANS", "4PK 16OZ" → { units, oz } */
function multiPack(desc: string): { units: number; oz: number } | null {
  const pk = desc.match(/\b(\d{1,2})\s*(?:PK|PACK|PAK|-PACK|CT)\b/i);
  const oz = desc.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:OZ|Z)\b/i);
  if (pk && oz) return { units: Number(pk[1]), oz: Number(oz[1]) };
  return null;
}

/**
 * Infer the bottle/pack size from a receipt line description.
 * Returns pack_size_text usable by parsePackSize ("750ML", "1.75L", "6/12OZ").
 */
export function inferBottleSize(description: string): BottleSize {
  const d = (description ?? "").toUpperCase();
  const mp = multiPack(d);
  if (mp) return { text: `${mp.units}/${mp.oz}OZ`, ml: Number((mp.units * mp.oz * ML_PER_OZ).toFixed(1)), assumed: false };
  const oz = d.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:OZ|FL ?OZ)\b/);
  if (oz && !/\bPK\b|\bPACK\b/.test(d)) return { text: `${oz[1]}OZ`, ml: Number((Number(oz[1]) * ML_PER_OZ).toFixed(1)), assumed: false };
  for (const s of SIZES) if (s.re.test(d)) return { text: s.text, ml: s.ml, assumed: false };
  return { text: "750ML", ml: 750, assumed: true };
}

/** The one-tap choices offered on the review screen. */
export const BOTTLE_SIZE_CHOICES = ["750ML", "1L", "1.75L", "375ML", "50ML"] as const;
