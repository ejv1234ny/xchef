# fixtures/invoices

Real (redacted) Mad Moose vendor documents used by the invoice pipeline tests
and replay scripts.

| Files | What they are |
|---|---|
| `Ferril.pdf`, `InvoiceFarrel.pdf`, `invoicefarrel*.pdf`, `invoicesfarel4.pdf` | Farrell Distributing (VT beer/wine/liquor) invoices |
| `RD*.pdf`, `rd 6-10*.pdf`, `invoice80*.pdf` | Restaurant Depot register receipts (scans / phone photos) |
| `Invoices.pdf` | multi-page scan bundle |
| `coca-cola-ne-bib-ticket.pdf` | Coca-Cola Beverages Northeast bag-in-box delivery ticket (category headers are subtotals, not lines; CO2 cylinder sale + deposit) |
| `Restaurant_Depot_Receipts.xlsx` | receipt scans transcribed to one sheet per receipt (import with `pnpm invoices:import-xlsx`) |
| `Restaurant_Depot_Items_8-6.xlsx` | the same lines grouped by category (used only for the category guess) |

## Expected files for the parser test

`lib/llm/invoice-parse.test.ts` looks for `<name>.expected.json` next to each
`<name>.pdf|jpg|png`. For every pair it parses the document with Sonnet and
asserts: `vendor_name` contains the expected vendor (case-insensitive), the line
count is within ±1, and Σ `extended_price` of product lines is within 2% of
`subtotal` when a subtotal is present. The suite is skipped without
`ANTHROPIC_API_KEY` or when no expected files exist.

Generate them once (needs `ANTHROPIC_API_KEY` in `.env.local`):

```
pnpm tsx scripts/gen-invoice-expected.ts            # all fixtures without an expected file
pnpm tsx scripts/gen-invoice-expected.ts --only RD   # a subset
pnpm tsx scripts/gen-invoice-expected.ts --force     # overwrite
```

Then open each JSON beside its PDF and correct it by hand — the expected file is
the ground truth the test holds the model to, not the model's own output.

Shape:

```json
{
  "vendor_name": "Restaurant Depot",
  "is_invoice": true,
  "document_kind": "invoice",
  "invoice_number": "I15336",
  "invoice_date": "2026-08-05",
  "subtotal": 1094.14,
  "total": 1094.14,
  "line_count": 30,
  "lines": [
    {
      "line_no": 1,
      "vendor_sku": "207722013213",
      "description": "PROSCIUTTO DANIELE",
      "pack_size_text": "13.21 LB @ $6.49/LB",
      "quantity": 1,
      "unit_price": 85.73,
      "extended_price": 85.73,
      "category_guess": "meat"
    }
  ]
}
```

Only `vendor_name`, `line_count` and `subtotal` are asserted today; the rest is
kept so stricter line-level assertions can be added without regenerating.

## Replaying through the real pipeline

```
pnpm invoices:replay                 # every PDF/JPG/PNG here → Storage → parse → map → post
pnpm invoices:replay --dir ~/scans   # another folder
pnpm invoices:import-xlsx --dry      # inspect the spreadsheet mapping without touching the DB
pnpm invoices:import-xlsx            # import the Restaurant Depot workbooks as manual invoices
```

Both need `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and (for
parsing / AI matching) `ANTHROPIC_API_KEY`.
