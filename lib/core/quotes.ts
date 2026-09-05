import Decimal from "decimal.js";
import { fixed4, fixed6 } from "./units";

/**
 * Outbound quote requests → forward pricing (KICKOFF-2 Part 3). Pure helpers:
 * the request token that threads a vendor's reply back to its quote_requests
 * row, the plain-text request email, and the conversion of one mapped quote
 * line into a vendor_quotes row. No I/O; the jobs in lib/jobs/quoteRequest.ts
 * and lib/jobs/quoteIngest.ts do the database and Resend work.
 */

/** RFC 4648 base32 alphabet (A–Z, 2–7): unambiguous in a subject line and safe in a regex. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const QUOTE_TOKEN_LENGTH = 6;

/** `Q-` + 6 base32 characters, e.g. `Q-7KD2PA`. `random` is injectable for tests (defaults to crypto). */
export function quoteToken(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(QUOTE_TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < QUOTE_TOKEN_LENGTH; i++) out += BASE32[(bytes[i] ?? 0) % 32];
  return `Q-${out}`;
}

function defaultRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/**
 * Find the request token in a subject or body: `[Q-7KD2PA]` preferred, a bare
 * `Q-7KD2PA` word accepted (mail clients sometimes strip brackets when
 * re-flowing a subject). Returns the normalized `Q-XXXXXX` or null.
 */
export function extractQuoteToken(text: string | null | undefined): string | null {
  if (!text) return null;
  const bracketed = text.match(/\[\s*Q-([A-Za-z2-7]{6})\s*\]/i);
  if (bracketed) return `Q-${bracketed[1].toUpperCase()}`;
  const bare = text.match(/(?:^|[^A-Za-z0-9-])Q-([A-Za-z2-7]{6})(?![A-Za-z0-9])/i);
  return bare ? `Q-${bare[1].toUpperCase()}` : null;
}

export type QuoteRequestItem = {
  vendor_sku: string | null;
  description: string;
  pack_description: string | null;
};

export type ComposedQuoteRequest = { subject: string; text: string };

/**
 * The email a vendor rep receives. Plain text on purpose: sales reps read
 * these on phones and reply inline or attach their price sheet. The subject
 * carries the token so the reply threads back to the request.
 */
export function composeQuoteRequest(input: { locationName: string; vendorName: string; items: QuoteRequestItem[]; token: string; replyTo: string }): ComposedQuoteRequest {
  const subject = `[${input.token}] Pricing request from ${input.locationName}`;
  const lines = input.items.map((it) => {
    const sku = it.vendor_sku ? `#${it.vendor_sku}  ` : "";
    const pack = it.pack_description ? `  (${it.pack_description})` : "";
    return `  - ${sku}${it.description}${pack}`;
  });
  const text = [
    `Hi ${input.vendorName} team,`,
    "",
    `Could you send us your current pricing for the items below? We'd like, for each one:`,
    "  * price per pack as you sell it (per case / per bottle / per lb),",
    "  * any specials, promos or case-deal pricing, and",
    "  * how long the prices are good for (valid from / through dates).",
    "",
    "Items:",
    ...lines,
    "",
    "If you have a price list as a PDF or spreadsheet, attaching it is perfect; otherwise a plain reply works.",
    `Please reply to this email (${input.replyTo}) and keep [${input.token}] in the subject so it files automatically.`,
    "",
    "Thanks,",
    input.locationName,
  ].join("\n");
  return { subject, text };
}

export type QuoteLineInput = {
  vendor_sku: string | null;
  description: string;
  pack_size_text: string | null;
  /** quoted price per pack as sold; string | number, converted via Decimal */
  unit_price: string | number | null;
  special_terms?: string | null;
  min_quantity?: string | number | null;
};

export type QuoteMappingRef = {
  id: string;
  inventory_item_id: string;
  units_per_pack: string | number;
  base_units_per_unit: string | number;
  pack_description: string | null;
};

export type QuoteDocumentDates = { valid_from: string | null; valid_through: string | null };

/** Values for one vendor_quotes row (numerics as fixed strings; the job converts with Number() at insert). */
export type VendorQuoteValues = {
  inventory_item_id: string | null;
  mapping_id: string | null;
  vendor_sku: string | null;
  description: string;
  pack_description: string | null;
  units_per_pack: string;
  base_units_per_unit: string | null;
  quoted_unit_price: string | null;
  cost_per_base_unit: string | null;
  special_terms: string | null;
  min_quantity: string | null;
  valid_from: string | null;
  valid_through: string | null;
};

function dec(v: string | number | null | undefined): Decimal | null {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(v);
    return d.isNaN() ? null : d;
  } catch {
    return null;
  }
}

/**
 * cost_per_base_unit = quoted_unit_price ÷ (units_per_pack × base_units_per_unit),
 * null when the pack is unknown (no mapping) or the price is missing. The pack
 * comes from the mapping the map step resolved (saved / confirmed / AI-created),
 * exactly as an invoice line's would (CLAUDE.md rule 4: never a hardcoded size).
 */
export function quoteLineToVendorQuote(line: QuoteLineInput, mapping: QuoteMappingRef | null, dates: QuoteDocumentDates): VendorQuoteValues {
  const price = dec(line.unit_price);
  const upp = mapping ? dec(mapping.units_per_pack) : null;
  const bupu = mapping ? dec(mapping.base_units_per_unit) : null;
  const perPack = upp && bupu ? upp.times(bupu) : null;
  const cost = price && perPack && perPack.gt(0) ? price.abs().div(perPack) : null;
  const minQty = dec(line.min_quantity);
  return {
    inventory_item_id: mapping?.inventory_item_id ?? null,
    mapping_id: mapping?.id ?? null,
    vendor_sku: line.vendor_sku?.trim() || null,
    description: line.description.trim() || "(no description)",
    pack_description: mapping?.pack_description ?? line.pack_size_text?.trim() ?? null,
    units_per_pack: fixed4(upp ?? new Decimal(1)),
    base_units_per_unit: bupu ? fixed4(bupu) : null,
    quoted_unit_price: price ? fixed4(price.abs()) : null,
    cost_per_base_unit: cost ? fixed6(cost) : null,
    special_terms: line.special_terms?.trim() || null,
    min_quantity: minQty ? fixed4(minQty) : null,
    valid_from: dates.valid_from ?? null,
    valid_through: dates.valid_through ?? null,
  };
}
