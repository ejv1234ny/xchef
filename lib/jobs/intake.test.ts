import { describe, expect, it } from "vitest";
import { diffParsedLines, diffLineFromInvoiceLine, diffLineFromParsed, diffLineFromSheet, matchVendor, sumDiffLines, type DiffLine } from "./intake";

/**
 * Pure helpers behind the vendor-portal attach step (KICKOFF-2 Part 2):
 * "paper said / portal says". Synthetic case modelled on a Restaurant Depot
 * receipt photographed at the door and the same receipt exported from the
 * portal the next morning.
 */

const line = (n: number, description: string, quantity: string, extended_price: string | null, vendor_sku: string | null = null, unit_price: string | null = null): DiffLine => ({
  line_no: n,
  vendor_sku,
  description,
  quantity,
  unit_price,
  extended_price,
});

const paper: DiffLine[] = [
  line(1, "KETCHUP 3/114OZ", "2.0000", "134.38", "RD-8891"),
  line(2, "KETCHUP 3/114OZ", "2.0000", "134.38", "RD-8891"),
  line(3, "BOTTLE DEPOSIT", "1.0000", "3.00"),
];

describe("diffParsedLines", () => {
  it("matches when the portal copy has the same lines and the same sum", () => {
    const portal = paper.map((l) => ({ ...l, description: l.description.toLowerCase() }));
    const d = diffParsedLines(paper, portal, new Date("2026-09-05T12:00:00Z"));
    expect(d.matches).toBe(true);
    expect(d.diffs).toEqual([]);
    expect(d.paper.sum).toBe("271.76");
    expect(d.portal.sum).toBe("271.76");
    expect(d.sum_delta).toBe("0.00");
    expect(d.compared_at).toBe("2026-09-05T12:00:00.000Z");
  });

  it("tolerates a one-cent rounding difference", () => {
    const portal = [paper[0], paper[1], line(3, "BOTTLE DEPOSIT", "1.0000", "3.01")];
    const d = diffParsedLines(paper, portal);
    expect(d.matches).toBe(true);
    expect(d.sum_delta).toBe("0.01");
    // the cent still shows up as a changed line for the review panel
    expect(d.diffs).toHaveLength(1);
    expect(d.diffs[0].kind).toBe("changed");
    expect(d.diffs[0].fields).toEqual(["extended_price"]);
  });

  it("flags a price change on a SKU-matched line and reports the money delta", () => {
    // portal says the second case of ketchup was billed at a different price
    const portal = [paper[0], line(2, "KETCHUP 3/114OZ", "2.0000", "129.38", "RD-8891"), paper[2]];
    const d = diffParsedLines(paper, portal);
    expect(d.matches).toBe(false);
    expect(d.sum_delta).toBe("-5.00");
    expect(d.diffs).toHaveLength(1);
    expect(d.diffs[0]).toMatchObject({ kind: "changed", fields: ["extended_price"] });
    expect(d.diffs[0].paper?.extended_price).toBe("134.38");
    expect(d.diffs[0].portal?.extended_price).toBe("129.38");
  });

  it("flags a line the camera missed and a line the portal dropped", () => {
    const portal = [paper[0], paper[1], line(3, "GLOVES NITRILE L", "1.0000", "18.99", "RD-1200")];
    const d = diffParsedLines(paper, portal);
    expect(d.matches).toBe(false);
    expect(d.paper.line_count).toBe(3);
    expect(d.portal.line_count).toBe(3);
    expect(d.diffs.map((x) => x.kind).sort()).toEqual(["missing_on_paper", "missing_on_portal"]);
    const missingOnPortal = d.diffs.find((x) => x.kind === "missing_on_portal");
    expect(missingOnPortal?.paper?.description).toBe("BOTTLE DEPOSIT");
    const missingOnPaper = d.diffs.find((x) => x.kind === "missing_on_paper");
    expect(missingOnPaper?.portal?.description).toBe("GLOVES NITRILE L");
  });

  it("does not match when the line count differs even if the sum agrees", () => {
    const portal = [line(1, "KETCHUP 3/114OZ", "4.0000", "268.76", "RD-8891"), paper[2]];
    const d = diffParsedLines(paper, portal);
    expect(d.sum_delta).toBe("0.00");
    expect(d.matches).toBe(false);
  });

  it("pairs by description when there is no SKU and picks the candidate with the same amount", () => {
    const p = [line(1, "Limes 200ct", "1.0000", "42.00"), line(2, "Limes 200ct", "1.0000", "44.00")];
    const portal = [line(1, "LIMES 200CT", "1.0000", "44.00"), line(2, "LIMES 200CT", "1.0000", "42.00")];
    const d = diffParsedLines(p, portal);
    expect(d.matches).toBe(true);
    expect(d.diffs).toEqual([]);
  });
});

describe("DiffLine adapters", () => {
  it("renders numbers as decimal strings and signs credit lines", () => {
    expect(diffLineFromInvoiceLine({ line_no: 1, vendor_sku: "A", description: "x", quantity: 2, unit_price: 3.5, extended_price: 7 })).toEqual({ line_no: 1, vendor_sku: "A", description: "x", quantity: "2.0000", unit_price: "3.5000", extended_price: "7.00" });
    expect(diffLineFromParsed({ line_no: 1, description: " Tito's 750 ", quantity: 2, unit_price: 20, extended_price: 40, category_guess: "liquor", confidence: 0.9 }, 4, true)).toEqual({ line_no: 5, vendor_sku: null, description: "Tito's 750", quantity: "-2.0000", unit_price: "20.0000", extended_price: "-40.00" });
    expect(
      diffLineFromSheet({ row_index: 9, vendor_sku: null, description: "Ketchup", pack_size_text: null, quantity: "2", unit_price: null, extended_price: "134.38", invoice_number: null, invoice_date: null, vendor_name: null, category_guess: null }, 0),
    ).toEqual({ line_no: 1, vendor_sku: null, description: "Ketchup", quantity: "2.0000", unit_price: null, extended_price: "134.38" });
    expect(sumDiffLines([line(1, "a", "1", "0.10"), line(2, "b", "1", "0.20"), line(3, "c", "1", null)])).toBe("0.30");
  });
});

describe("matchVendor", () => {
  const vendors = [
    { id: "1", name: "Sysco", email_domains: ["sysco.com"] },
    { id: "2", name: "Performance Food Group", email_domains: [] },
    { id: "3", name: "Restaurant Depot", email_domains: null },
  ];
  it("matches exact, containment and sender domain, and nothing otherwise", () => {
    expect(matchVendor(vendors, "restaurant depot")?.id).toBe("3");
    expect(matchVendor(vendors, "Sysco Albany")?.id).toBe("1");
    expect(matchVendor(vendors, "PFG")).toBeUndefined();
    expect(matchVendor(vendors, "Nobody", "sysco.com")?.id).toBe("1");
    expect(matchVendor(vendors, "Nobody")).toBeUndefined();
  });
});
