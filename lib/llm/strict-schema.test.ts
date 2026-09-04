import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertStrictSchema, stripOptionalNulls, toStrictJsonSchema } from "./strict-schema";
import { InvoiceParseSchema } from "./invoice-parse";
import { SkuMatchSchema } from "./sku-match";
import { RecipeDraftSchema } from "./recipe-draft";
import { SheetMapSchema } from "./sheet-map";

const SCHEMAS: Array<[string, z.ZodType]> = [
  ["extract_invoice", InvoiceParseSchema],
  ["match_sku", SkuMatchSchema],
  ["draft_recipe", RecipeDraftSchema],
  ["map_columns", SheetMapSchema],
];

describe("zod → OpenAI strict JSON schema", () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name}: every object has additionalProperties=false, all properties required, no unsupported keywords`, () => {
      const { schema: strict } = toStrictJsonSchema(schema);
      expect(strict.type).toBe("object");
      expect(assertStrictSchema(strict)).toEqual([]);
      expect(JSON.stringify(strict)).not.toMatch(/"(minimum|maximum|pattern|format|minLength|maxLength|exclusiveMinimum)"/);
    });
  }

  it("optional fields become nullable and their null values are stripped before zod validation", () => {
    const s = z.object({
      a: z.string().optional(),
      b: z.number().min(0).max(1),
      c: z.string().nullable().optional(),
      d: z.uuid().nullable().optional(),
      list: z.array(z.object({ note: z.string().optional(), q: z.number().positive() })),
    });
    const { schema, optionalPaths } = toStrictJsonSchema(s);
    const props = schema.properties as Record<string, unknown>;
    expect(schema.required).toEqual(["a", "b", "c", "d", "list"]);
    expect(JSON.stringify(props.a)).toContain('"null"');
    expect(optionalPaths).toEqual(["a", "list[].note"]); // c and d already accept null
    const modelOutput = { a: null, b: 0.5, c: null, d: null, list: [{ note: null, q: 1 }, { note: "x", q: 2 }] };
    const cleaned = stripOptionalNulls(modelOutput, optionalPaths);
    expect(() => s.parse(modelOutput)).toThrow(); // `a` and `note` are optional but not nullable
    const parsed = s.parse(cleaned);
    expect(parsed).toEqual({ b: 0.5, c: null, d: null, list: [{ q: 1 }, { note: "x", q: 2 }] });
  });

  it("invoice parse output with nulls for absent optionals round-trips through the real schema", () => {
    const { optionalPaths } = toStrictJsonSchema(InvoiceParseSchema);
    const out = {
      documents: [
        {
          is_invoice: false,
          document_kind: "statement",
          vendor_name: "PFG",
          receipt_id: null,
          transaction_code: null,
          invoice_number: null,
          invoice_date: null,
          invoice_time: null,
          received_date: null,
          subtotal: null,
          tax: null,
          total: null,
          currency: "USD",
          printed_item_count: null,
          region: null,
          lines: [],
          confidence: 0.9,
        },
      ],
      page_notes: null,
    };
    const parsed = InvoiceParseSchema.parse(stripOptionalNulls(out, optionalPaths));
    expect(parsed.documents[0].document_kind).toBe("statement");
  });
});
