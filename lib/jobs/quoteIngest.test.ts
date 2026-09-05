import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import Decimal from "decimal.js";
import { config } from "dotenv";
import type { Json } from "@/lib/db/types";
import type { ServiceClient } from "@/lib/db/service";

config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });

const hasDb = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

/**
 * Gate 3 (KICKOFF-2 Part 3), against xchef-dev: a quote document with one
 * mapped line → ingestQuoteLines → one vendor_quotes row with the right cost
 * per base unit; purchases_by_item for that ingredient is unchanged;
 * forward_price_model says basis = 'quote' for (item, test vendor) and
 * 'invoice' for every other vendor of that item; vendor_switch_savings shows
 * the quote-based row when the item is also invoiced by someone else.
 * Everything it creates is deleted afterwards.
 */
describe.skipIf(!hasDb)("ingestQuoteLines against xchef-dev", () => {
  const stamp = Date.now();
  let svc: ServiceClient;
  let tenantId: string;
  let locationId: string;
  let itemId: string;
  let itemHasInvoicedPrice = false;
  let vendorId: string;
  let mappingId: string;
  let requestId: string;
  let documentId: string;

  // 1 × 100 base units per pack, quoted $1.00 per pack → $0.01 per base unit: cheaper than anything real, so the savings view must pick it.
  const UNITS_PER_PACK = 1;
  const BASE_UNITS_PER_UNIT = 100;
  const QUOTED_PRICE = 1.0;
  const EXPECTED_COST = new Decimal(QUOTED_PRICE).div(UNITS_PER_PACK * BASE_UNITS_PER_UNIT); // 0.01

  beforeAll(async () => {
    const { createServiceSupabase } = await import("@/lib/db/service");
    svc = createServiceSupabase();
    const { data: loc } = await svc.from("locations").select("id, tenant_id").order("created_at").limit(1).single();
    locationId = loc!.id;
    tenantId = loc!.tenant_id;

    // Prefer an ingredient that already has an invoiced price from a real vendor (so the comparison has two options).
    const { data: invoiced } = await svc.from("forward_price_model").select("inventory_item_id").eq("tenant_id", tenantId).not("last_invoiced_cost", "is", null).limit(1);
    if (invoiced?.[0]?.inventory_item_id) {
      itemId = invoiced[0].inventory_item_id;
      itemHasInvoicedPrice = true;
    } else {
      const { data: any } = await svc.from("inventory_items").select("id").eq("tenant_id", tenantId).order("name").limit(1).single();
      itemId = any!.id;
    }

    const { data: vendor } = await svc.from("vendors").insert({ tenant_id: tenantId, name: `Quote Test Vendor ${stamp}`, kind: "distributor", contact_email: "quotes-test@example.invalid" }).select("id").single();
    vendorId = vendor!.id;
    const { data: mapping } = await svc
      .from("vendor_item_mappings")
      .insert({ tenant_id: tenantId, vendor_id: vendorId, vendor_sku: `QT-${stamp}`, description_norm: `quote test item ${stamp}`, inventory_item_id: itemId, units_per_pack: UNITS_PER_PACK, base_units_per_unit: BASE_UNITS_PER_UNIT, pack_description: "test pack", confirmed_at: new Date().toISOString() })
      .select("id")
      .single();
    mappingId = mapping!.id;
    const { data: req } = await svc.from("quote_requests").insert({ tenant_id: tenantId, location_id: locationId, vendor_id: vendorId, token: `Q-T${String(stamp).slice(-5)}`, items: [] as unknown as Json, status: "sent" }).select("id").single();
    requestId = req!.id;
  });

  afterAll(async () => {
    if (!svc) return;
    if (documentId) {
      await svc.from("vendor_quotes").delete().eq("source_document_id", documentId);
      await svc.from("invoice_lines").delete().eq("invoice_id", documentId);
      await svc.from("quote_requests").update({ reply_document_id: null }).eq("id", requestId);
      await svc.from("invoice_documents").delete().eq("id", documentId);
    }
    if (requestId) await svc.from("quote_requests").delete().eq("id", requestId);
    if (vendorId) {
      await svc.from("vendor_quotes").delete().eq("vendor_id", vendorId);
      await svc.from("vendor_item_mappings").delete().eq("vendor_id", vendorId);
      await svc.from("vendors").delete().eq("id", vendorId);
    }
  });

  it("writes vendor_quotes, leaves purchases alone, flips forward_price_model to basis 'quote', posts the document", async () => {
    const { ingestQuoteLines } = await import("./quoteIngest");

    const purchasesBefore = await svc.from("purchases_by_item").select("quantity_base_unit, cost").eq("location_id", locationId).eq("inventory_item_id", itemId);
    const sum = (rows: Array<{ quantity_base_unit: number | null; cost: number | null }> | null) =>
      (rows ?? []).reduce((a, r) => ({ qty: a.qty.plus(r.quantity_base_unit ?? 0), cost: a.cost.plus(r.cost ?? 0), n: a.n + 1 }), { qty: new Decimal(0), cost: new Decimal(0), n: 0 });
    const before = sum(purchasesBefore.data);

    // The document as intake + parse would leave it: flagged quote, needs_review, parser output on raw_extraction.
    const extraction = {
      kind: "llm",
      document: {
        is_invoice: false,
        document_kind: "quote",
        vendor_name: `Quote Test Vendor ${stamp}`,
        currency: "USD",
        valid_from: "2026-09-01",
        valid_through: "2099-12-31",
        confidence: 0.95,
        lines: [{ line_no: 1, vendor_sku: `QT-${stamp}`, description: `QUOTE TEST ITEM ${stamp}`, pack_size_text: "test pack", quantity: 1, unit_price: QUOTED_PRICE, extended_price: QUOTED_PRICE, category_guess: "dry", confidence: 0.95, special_terms: "buy 5 get 1 free", min_quantity: 5 }],
      },
    };
    const { data: doc, error: derr } = await svc
      .from("invoice_documents")
      .insert({
        location_id: locationId,
        vendor_id: vendorId,
        source: "paste",
        status: "needs_review",
        storage_path: `test/quote-${stamp}.txt`,
        content_hash: `quote-test-${stamp}`,
        document_kind: "quote",
        invoice_date: "2026-09-01",
        raw_extraction: extraction as unknown as Json,
      })
      .select("id")
      .single();
    expect(derr).toBeNull();
    documentId = doc!.id;
    await svc.from("quote_requests").update({ reply_document_id: documentId, status: "replied" }).eq("id", requestId);

    // The line as the map step leaves it: auto_mapped through the mapping, base units computed.
    const { error: lerr } = await svc.from("invoice_lines").insert({
      invoice_id: documentId,
      line_no: 1,
      vendor_sku: `QT-${stamp}`,
      description: `QUOTE TEST ITEM ${stamp}`,
      pack_size_text: "test pack",
      quantity: 1,
      unit_price: QUOTED_PRICE,
      extended_price: QUOTED_PRICE,
      status: "auto_mapped",
      mapping_id: mappingId,
      inventory_item_id: itemId,
      quantity_base_unit: UNITS_PER_PACK * BASE_UNITS_PER_UNIT,
      cost_per_base_unit: Number(EXPECTED_COST.toFixed(6)),
      ai_category_guess: "dry",
    });
    expect(lerr).toBeNull();

    const r = await ingestQuoteLines(svc, documentId);
    expect(r).toMatchObject({ documentId, quotes: 1, withoutCost: 0, skippedLines: 0, status: "posted", quoteRequestId: requestId });

    // vendor_quotes: the row, with the cost per base unit from the mapping's pack
    const { data: quotes } = await svc.from("vendor_quotes").select("*").eq("source_document_id", documentId);
    expect(quotes).toHaveLength(1);
    const q = quotes![0];
    expect(q.vendor_id).toBe(vendorId);
    expect(q.inventory_item_id).toBe(itemId);
    expect(q.mapping_id).toBe(mappingId);
    expect(q.quote_request_id).toBe(requestId);
    expect(Number(q.quoted_unit_price)).toBeCloseTo(QUOTED_PRICE, 4);
    expect(Number(q.units_per_pack)).toBe(UNITS_PER_PACK);
    expect(Number(q.base_units_per_unit)).toBe(BASE_UNITS_PER_UNIT);
    expect(new Decimal(q.cost_per_base_unit!).toFixed(6)).toBe(EXPECTED_COST.toFixed(6));
    expect(q.special_terms).toBe("buy 5 get 1 free");
    expect(Number(q.min_quantity)).toBe(5);
    expect(q.valid_from).toBe("2026-09-01");
    expect(q.valid_through).toBe("2099-12-31");

    // The document is posted and still a quote.
    const { data: after } = await svc.from("invoice_documents").select("status, document_kind, posted_at").eq("id", documentId).single();
    expect(after).toMatchObject({ status: "posted", document_kind: "quote" });
    expect(after!.posted_at).not.toBeNull();

    // purchases_by_item: unchanged — a posted quote is not a purchase.
    const purchasesAfter = await svc.from("purchases_by_item").select("quantity_base_unit, cost").eq("location_id", locationId).eq("inventory_item_id", itemId);
    const afterSum = sum(purchasesAfter.data);
    expect(afterSum.n).toBe(before.n);
    expect(afterSum.qty.toFixed(4)).toBe(before.qty.toFixed(4));
    expect(afterSum.cost.toFixed(2)).toBe(before.cost.toFixed(2));
    // and item_price_history never sees it
    const { data: hist } = await svc.from("item_price_history").select("invoice_id").eq("invoice_id", documentId);
    expect(hist ?? []).toHaveLength(0);

    // forward_price_model: quote basis for (item, test vendor); invoice basis for everyone else on this item.
    const { data: fpm } = await svc.from("forward_price_model").select("*").eq("tenant_id", tenantId).eq("inventory_item_id", itemId);
    const mine = (fpm ?? []).find((f) => f.vendor_id === vendorId);
    expect(mine).toBeDefined();
    expect(mine!.basis).toBe("quote");
    expect(new Decimal(mine!.best_quoted_cost!).toFixed(6)).toBe(EXPECTED_COST.toFixed(6));
    expect(new Decimal(mine!.expected_next_cost!).toFixed(6)).toBe(EXPECTED_COST.toFixed(6));
    expect(mine!.quote_valid_through).toBe("2099-12-31");
    expect(mine!.last_invoiced_cost).toBeNull();
    for (const other of (fpm ?? []).filter((f) => f.vendor_id !== vendorId)) expect(other.basis).toBe("invoice");

    if (itemHasInvoicedPrice) {
      // vendor_switch_savings: the invoiced vendor's row now points at the quote as the cheaper option.
      const { data: sav } = await svc.from("vendor_switch_savings").select("*").eq("location_id", locationId).eq("inventory_item_id", itemId);
      const row = (sav ?? []).find((s) => s.cheapest_vendor === `Quote Test Vendor ${stamp}`);
      expect(row).toBeDefined();
      expect(row!.cheapest_basis).toBe("quote");
      expect(row!.cheapest_quote_valid_through).toBe("2099-12-31");
      expect(row!.current_basis).toBe("invoice");
      expect(new Decimal(row!.cheapest_cost!).toFixed(6)).toBe(EXPECTED_COST.toFixed(6));
    }

    // Idempotent: a second run rewrites, never duplicates.
    const r2 = await ingestQuoteLines(svc, documentId);
    expect(r2.quotes).toBe(1);
    const { count } = await svc.from("vendor_quotes").select("id", { count: "exact", head: true }).eq("source_document_id", documentId);
    expect(count).toBe(1);
  }, 60_000);
});
