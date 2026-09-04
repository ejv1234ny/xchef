import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "./openai";
import { parseInvoiceDocument } from "./invoice-parse";
import { matchSku } from "./sku-match";
import { draftRecipe } from "./recipe-draft";
import { mapSheetColumns } from "./sheet-map";

/** Fake Responses API: records the request and answers with a fixed JSON object as output_text. */
function fakeOpenAI(answer: unknown, model = "gpt-4.1") {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const response = {
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }] }],
      usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { provider: createOpenAIProvider({ apiKey: "sk-test", fetch: fetchImpl }), calls };
}

describe("OpenAI provider (Responses API, mocked HTTP)", () => {
  it("invoice-parse: PDF goes as input_file, strict json_schema format, temperature 0, gpt-4.1, cost computed", async () => {
    const answer = {
      documents: [
        {
          is_invoice: true,
          document_kind: "invoice",
          vendor_name: "Sysco",
          receipt_id: "SY-1",
          transaction_code: null,
          invoice_number: "SY-1",
          invoice_date: "2026-08-21",
          invoice_time: null,
          received_date: null,
          subtotal: 125,
          tax: null,
          total: 125,
          currency: "USD",
          printed_item_count: 1,
          region: "full",
          lines: [{ line_no: 1, vendor_sku: "1234567", description: "KETCHUP 6/#10", pack_size_text: "6/#10", quantity: 2, unit_price: 62.5, gross_price: 125, adjustment: null, extended_price: 125, category_guess: "dry", confidence: 0.98 }],
          confidence: 0.97,
        },
      ],
      page_notes: null,
    };
    const { provider, calls } = fakeOpenAI(answer);
    const r = await parseInvoiceDocument({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf", filename: "sysco.pdf", vendorHint: "Sysco" }, provider);
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4.1");
    expect(r.data.documents[0].lines[0].description).toBe("KETCHUP 6/#10");
    expect(r.data.documents[0].received_date ?? null).toBeNull();
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 300, cost_usd: (1200 * 2 + 300 * 8) / 1_000_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/responses");
    const body = calls[0].body;
    expect(body.model).toBe("gpt-4.1");
    expect(body.temperature).toBe(0);
    const text = body.text as { format: { type: string; name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(text.format.type).toBe("json_schema");
    expect(text.format.strict).toBe(true);
    expect(text.format.name).toBe("extract_invoice");
    expect(text.format.schema.additionalProperties).toBe(false);
    const input = body.input as Array<{ role: string; content: unknown }>;
    expect(input[0].role).toBe("system");
    const parts = input[1].content as Array<{ type: string; filename?: string; file_data?: string }>;
    expect(parts[0].type).toBe("input_text");
    expect(parts[1].type).toBe("input_file");
    expect(parts[1].filename).toBe("sysco.pdf");
    expect(parts[1].file_data?.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  it("invoice-parse: images go as input_image data URLs", async () => {
    const { provider, calls } = fakeOpenAI({ documents: [{ is_invoice: false, document_kind: "other", vendor_name: "", receipt_id: null, transaction_code: null, invoice_number: null, invoice_date: null, invoice_time: null, received_date: null, subtotal: null, tax: null, total: null, currency: "USD", printed_item_count: null, region: null, lines: [], confidence: 0.5 }], page_notes: null });
    await parseInvoiceDocument({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", filename: "IMG_1.jpg" }, provider);
    const parts = (calls[0].body.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[1].content;
    expect(parts[1].type).toBe("input_image");
    expect(parts[1].image_url?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("sku-match uses gpt-4.1-mini and validates the SkuMatch shape", async () => {
    const answer = { choice: "existing", inventory_item_id: "5b1f2a0e-0000-4000-8000-000000000001", new_item: null, pack: { units_per_pack: 6, base_units_per_unit: 106 }, brand: "Heinz", pack_description: "6 × #10 can", confidence: 0.95, reason: "same ingredient" };
    const { provider, calls } = fakeOpenAI(answer, "gpt-4.1-mini");
    const r = await matchSku(
      {
        line: { description: "KETCHUP 6/#10", vendor_sku: "1234567", pack_size_text: "6/#10", unit_price: "62.50", extended_price: "125.00", quantity: "2", category_guess: "dry" },
        vendorName: "Sysco",
        inventory: [{ id: "5b1f2a0e-0000-4000-8000-000000000001", name: "Ketchup", category: "dry", base_unit: "oz", pack_to_base_factor: 636 }],
      },
      provider,
    );
    expect(calls[0].body.model).toBe("gpt-4.1-mini");
    expect(r.data.choice).toBe("existing");
    expect(r.data.pack.base_units_per_unit).toBe(106);
    expect(r.usage.cost_usd).toBeCloseTo((1200 * 0.4 + 300 * 1.6) / 1_000_000, 9);
  });

  it("recipe-draft validates nulls for optional fields (note / is_composite / new_item)", async () => {
    const answer = {
      components: [{ existing_inventory_item_id: "5b1f2a0e-0000-4000-8000-000000000002", new_item: null, quantity: 1.5, unit: "oz", confidence: 0.9, note: null }],
      is_composite: null,
      overall_confidence: 0.9,
    };
    const { provider } = fakeOpenAI(answer);
    const r = await draftRecipe(
      { menuItem: { id: "m1", name: "Classic Margarita", category: "cocktails", price: 12 }, modifierNames: [], inventory: [{ id: "5b1f2a0e-0000-4000-8000-000000000002", name: "Tequila - Blanco", category: "liquor", base_unit: "oz" }] },
      provider,
    );
    expect(r.data.components[0].quantity).toBe(1.5);
    expect(r.data.components[0].note).toBeUndefined();
    expect(r.data.is_composite).toBeUndefined();
  });

  it("sheet-map returns a usable column map", async () => {
    const { provider } = fakeOpenAI({ columns: [{ index: 0, role: "vendor_sku" }, { index: 1, role: "description" }, { index: 2, role: "quantity" }, { index: 3, role: "extended_price" }], vendor_name_guess: "Sysco", confidence: 0.9, notes: null }, "gpt-4.1-mini");
    const r = await mapSheetColumns({ headerCells: ["Item #", "Product", "Qty", "Amount"], sampleRows: [["1", "KETCHUP", "2", "125.00"]], filename: "x.csv", sheetName: "x" }, provider);
    expect(r.columnMap).toEqual({ "0": "vendor_sku", "1": "description", "2": "quantity", "3": "extended_price" });
  });

  it("surfaces a refusal and non-JSON output as plain errors", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ id: "r", object: "response", status: "completed", model: "gpt-4.1", output: [{ id: "m", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    const provider = createOpenAIProvider({ apiKey: "sk-test", fetch: fetchImpl });
    await expect(parseInvoiceDocument({ text: "hello world invoice", mimeType: "text/plain", filename: "paste.txt" }, provider)).rejects.toThrow(/refused/);
  });
});
