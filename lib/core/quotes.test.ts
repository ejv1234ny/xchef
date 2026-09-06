import { describe, expect, it } from "vitest";
import { composeQuoteRequest, extractQuoteToken, quoteLineToVendorQuote, quoteToken } from "./quotes";

describe("quoteToken / extractQuoteToken", () => {
  it("makes Q- + 6 base32 chars and is deterministic for a given random source", () => {
    const t = quoteToken();
    expect(t).toMatch(/^Q-[A-Z2-7]{6}$/);
    const fixed = quoteToken((n) => new Uint8Array(Array.from({ length: n }, (_, i) => i * 7)));
    expect(fixed).toBe("Q-AHOV4D");
    // 255 % 32 = 31 → "7"; every byte maps into the alphabet
    expect(quoteToken(() => new Uint8Array([255, 255, 255, 255, 255, 255]))).toBe("Q-777777");
  });

  it("finds the token in a reply subject, a quoted body, or bare; ignores look-alikes", () => {
    expect(extractQuoteToken("RE: [Q-7KD2PA] Pricing request from Mad Moose Bar & Grill")).toBe("Q-7KD2PA");
    expect(extractQuoteToken("Re: Fwd: [ q-7kd2pa ] pricing")).toBe("Q-7KD2PA");
    expect(extractQuoteToken("> Subject: [Q-ABCDEF] Pricing request\n> Items:")).toBe("Q-ABCDEF");
    expect(extractQuoteToken("your request Q-ABCDEF is attached")).toBe("Q-ABCDEF");
    expect(extractQuoteToken("FAQ-ABCDEF is not a token")).toBeNull(); // glued to a word
    expect(extractQuoteToken("Q-ABCDEFG too long")).toBeNull();
    expect(extractQuoteToken("Q-ABCD1E has a 1 (not base32)")).toBeNull();
    expect(extractQuoteToken("Invoice 12345")).toBeNull();
    expect(extractQuoteToken(null)).toBeNull();
  });
});

describe("composeQuoteRequest", () => {
  it("writes a plain-text request with the token in the subject and every item listed", () => {
    const r = composeQuoteRequest({
      locationName: "Mad Moose Bar & Grill",
      vendorName: "802 Spirits",
      token: "Q-7KD2PA",
      replyTo: "invoices@example.resend.app",
      items: [
        { vendor_sku: "0001", description: "TITOS VODKA 750ML", pack_description: "750 ml bottle" },
        { vendor_sku: null, description: "BEEFEATER GIN 750ML", pack_description: null },
      ],
    });
    expect(r.subject).toBe("[Q-7KD2PA] Pricing request from Mad Moose Bar & Grill");
    expect(r.text).toContain("Hi 802 Spirits team");
    expect(r.text).toContain("  - #0001  TITOS VODKA 750ML  (750 ml bottle)");
    expect(r.text).toContain("  - BEEFEATER GIN 750ML");
    expect(r.text).toMatch(/price per pack/i);
    expect(r.text).toMatch(/specials|case-deal/i);
    expect(r.text).toMatch(/valid from \/ through/i);
    expect(r.text).toMatch(/PDF or spreadsheet/);
    expect(r.text).toContain("invoices@example.resend.app");
    expect(r.text).toContain("[Q-7KD2PA]");
    expect(r.text.trim().endsWith("Mad Moose Bar & Grill")).toBe(true);
  });
  it("signs with the owner's first name above the location when the tenant has one", () => {
    const r = composeQuoteRequest({ locationName: "Mad Moose Bar & Grill", vendorName: "Sysco", token: "Q-7KD2PA", replyTo: "x@y.z", items: [], ownerFirstName: "Eric" });
    expect(r.text.trim().endsWith("Thanks,\nEric\nMad Moose Bar & Grill")).toBe(true);
  });
});

describe("quoteLineToVendorQuote", () => {
  const dates = { valid_from: "2026-09-01", valid_through: "2026-09-30" };

  it("cost per base unit = quoted price ÷ (units_per_pack × base_units_per_unit) via Decimal", () => {
    // 802 Spirits mapping: 1 bottle × 25.3605 oz; Tito's quoted $41.50 / bottle
    const v = quoteLineToVendorQuote(
      { vendor_sku: "0001", description: "TITOS VODKA 750ML", pack_size_text: "750ML", unit_price: 41.5, special_terms: "case of 12 $480", min_quantity: null },
      { id: "map-1", inventory_item_id: "item-titos", units_per_pack: 1, base_units_per_unit: "25.3605", pack_description: "750 ml bottle" },
      dates,
    );
    expect(v).toMatchObject({
      inventory_item_id: "item-titos",
      mapping_id: "map-1",
      vendor_sku: "0001",
      pack_description: "750 ml bottle",
      units_per_pack: "1.0000",
      base_units_per_unit: "25.3605",
      quoted_unit_price: "41.5000",
      special_terms: "case of 12 $480",
      min_quantity: null,
      valid_from: "2026-09-01",
      valid_through: "2026-09-30",
    });
    // 41.50 / 25.3605 = 1.636403...
    expect(v.cost_per_base_unit).toBe("1.636403");
  });

  it("case quote: Sysco ketchup 6/#10 at $62.50 per case → per oz over 6 × 106 oz", () => {
    const v = quoteLineToVendorQuote(
      { vendor_sku: "1234567", description: "KETCHUP 6/#10", pack_size_text: "6/#10", unit_price: "62.50", min_quantity: 5 },
      { id: "map-2", inventory_item_id: "item-ketchup", units_per_pack: "6", base_units_per_unit: "106", pack_description: "6 × #10 can" },
      { valid_from: null, valid_through: "2026-09-30" },
    );
    expect(v.cost_per_base_unit).toBe("0.098270"); // 62.5 / 636
    expect(v.min_quantity).toBe("5.0000");
    expect(v.valid_from).toBeNull();
  });

  it("unknown pack (no mapping) keeps the quoted price but has no cost per base unit", () => {
    const v = quoteLineToVendorQuote({ vendor_sku: null, description: "MYSTERY SAUCE", pack_size_text: "CS", unit_price: 30 }, null, dates);
    expect(v.inventory_item_id).toBeNull();
    expect(v.mapping_id).toBeNull();
    expect(v.pack_description).toBe("CS");
    expect(v.units_per_pack).toBe("1.0000");
    expect(v.base_units_per_unit).toBeNull();
    expect(v.quoted_unit_price).toBe("30.0000");
    expect(v.cost_per_base_unit).toBeNull();
  });

  it("missing price → null price and cost; zero pack → null cost", () => {
    const m = { id: "m", inventory_item_id: "i", units_per_pack: 1, base_units_per_unit: 0, pack_description: null };
    expect(quoteLineToVendorQuote({ vendor_sku: null, description: "X", pack_size_text: null, unit_price: null }, m, dates).quoted_unit_price).toBeNull();
    expect(quoteLineToVendorQuote({ vendor_sku: null, description: "X", pack_size_text: null, unit_price: 10 }, m, dates).cost_per_base_unit).toBeNull();
  });
});
