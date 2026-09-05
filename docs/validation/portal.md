# Vendor-portal pull — validation (KICKOFF-2 Part 2, Gate 2)

**Status: DRY RUN PASSED 2026-09-05** against a local dev server carrying the new route
(`corepack pnpm dev -p 3117`; port 3111 was already taken by another process). Production
(`https://xchef.vercel.app`) did not yet include the `x-intake-key` path at the time of the run,
so the production dry run is the first thing to re-run after deploy (command below). No real
portal credentials existed, so the browser adapters (`lib/portals/pfg.ts`, `lib/portals/sysco.ts`)
are untested against the live portals — their selectors are best-effort by design and fail loudly
with a screenshot.

## What the dry run proves

`pnpm portal:pull --dry` POSTs `fixtures/invoices/synthetic-rd-receipt.csv` to
`/api/intake/upload` three times with the `x-intake-key`, `x-vendor: Restaurant Depot` and
`x-invoice-number` headers. The fixture's invoice number (`I99001`) is made unique per run
(digits appended, still parsed by the Restaurant Depot layout) so the first POST is a real
creation even though an earlier `pnpm invoices:replay` already stored the fixture as
`4a539923-e90e-4786-80ce-718d285c8367` (source `upload`, left untouched).

| POST | bytes | expected | proves |
|---|---|---|---|
| 1 | fixture | one new document, `source = 'api'`, parsed (sheet layout) → mapped → posted | intake auth + normal pipeline |
| 2 | identical | same document id, `duplicate: true`, `attached: true`, outcome `duplicate` | no second document for the same file |
| 3 | note line changed (different hash), same invoice number | same document id, `attached: true`, outcome `stored`, `clean_storage_path` set | attach by `(vendor_id, invoice_number)` |

Outcome `stored` (not `verified`/`needs_review`) is correct here: the existing document is
`source = 'api'` with a CSV file, i.e. not paper, so nothing is re-read. The paper path
(image or scanned-PDF document → re-read the clean copy → compare Σ extended_price and line
count → `verified_by_clean_copy_at` or `parse_diff`) is covered by the unit tests of the pure
helper `diffParsedLines` in `lib/jobs/intake.test.ts`; running it end to end would have meant
altering a real posted Mad Moose receipt in production, so it was not exercised live.

## Run 2026-09-05 15:16 UTC — local dev server, production database

```
XCHEF_BASE_URL=http://localhost:3117 corepack pnpm portal:pull --dry --keep
```

| step | http | documentId | status | duplicate | attached | outcome | lines | mapped | ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 create | 200 | ac77d126-8774-47a9-b88f-39a27c8ef56a | posted | false | false | — | 3 | 2 | 6432 |
| 2 same bytes | 200 | ac77d126-8774-47a9-b88f-39a27c8ef56a | posted | true | true | duplicate | 3 | 2 | 422 |
| 3 clean copy | 200 | ac77d126-8774-47a9-b88f-39a27c8ef56a | posted | false | true | stored | 3 | 2 | 581 |

Confirmed with the service client afterwards:

- `invoice_documents ac77d126-…`: `source = 'api'`, `status = 'posted'`, vendor Restaurant Depot
  (`d9dc07ac-4845-4c42-acef-aa3f479c742b`), `invoice_number = 'I99001621375613'`,
  `invoice_date = 2026-08-20`, `subtotal = 271.76`,
  `storage_path = …/ef9b80ba….csv`, `clean_storage_path = …/fd0476e1….csv`,
  `verified_by_clean_copy_at = null`, `parse_diff = null`.
  Lines: KETCHUP 3/114OZ ×2 $134.38 (auto_mapped), KETCHUP 3/114OZ ×2 $134.38 (auto_mapped),
  BOTTLE DEPOSIT ×1 $3.00 (ignored). Exactly one document carried the run's invoice number.
- `inbound_events` (provider `portal`, event_type `portal.pull`, from_address `Restaurant Depot`):
  - `3191c018-8933-448b-8861-c962cf91c35b` subject `synthetic-rd-receipt.csv`, documents_created 1
  - `f8843e55-35f5-4824-9f4f-6173d735bba2` subject `synthetic-rd-receipt.csv`, documents_created 0
  - `0aa92d82-a113-455d-a32f-add862c424c4` subject `synthetic-rd-receipt-portal.csv`, documents_created 0
  All three list `document_ids = [ac77d126-…]`, `error = null`.
- Auth probes on the same server: `x-intake-key: wrong` → 401; no key and no session → 401.

Cleanup (done): document `ac77d126-…`, its 3 lines, both stored files and the 3 portal
`inbound_events` rows were deleted. Without `--keep` the script does this itself whenever the
database env is present.

## Re-run after deploy (production)

```
corepack pnpm portal:pull --dry
```
with `XCHEF_BASE_URL=https://xchef.vercel.app` in the environment (or `NEXT_PUBLIC_APP_URL`).
`INTAKE_API_KEY` from `.env.local` is the same value as on Vercel. Expect the same three rows;
the script exits non-zero and prints `dry run FAILED: …` otherwise.

## GitHub Actions

`.github/workflows/portal-pull.yml` — schedule `0 11 * * *` UTC (real pull), `workflow_dispatch`
with `dry_run` (default true) and `vendor`. Secrets to add (names only):
`XCHEF_BASE_URL`, `XCHEF_INTAKE_KEY`, `PORTAL_PFG_USER`, `PORTAL_PFG_PASS`, `PORTAL_SYSCO_USER`,
`PORTAL_SYSCO_PASS`. The runner has no database access on purpose (the service-role key stays on
Vercel), so a dry run in Actions cannot delete the synthetic document it creates: it prints
`CLEANUP NEEDED: synthetic document <id> …`. Prefer running the dry run locally; use the
workflow's dry run only to prove the runner can reach the endpoint. Scheduled (real) runs never
touch the fixture.

## Decision table implemented (`lib/jobs/intake.ts`)

| `api` arrival with (vendor, invoice_number) | action | outcome |
|---|---|---|
| no document with that pair at the location (or no vendor/number header) | `createInvoiceDocument(source 'api')` + `runInvoicePipeline` | `created` (or `duplicate` on content hash) |
| identical bytes already stored (existing `content_hash`, or any document's) | nothing written | `duplicate` |
| existing document is not paper (`api`, `manual`, `paste`, spreadsheet, text PDF, or rejected) | file stored, `clean_storage_path` set | `stored` |
| existing paper document (`upload`/`forward`/`email` + image, or PDF with no text layer) — clean copy re-read; Σ extended within $0.01 and same line count | `verified_by_clean_copy_at = now()`, posted lines kept | `verified` |
| same, but totals or line count differ | `status = 'needs_review'`, `parse_diff = { paper, portal, diffs, sum_delta }` rendered on the review page | `needs_review` |
| clean copy cannot be read (no LLM key, unreadable sheet) | file stored, note in `inbound_events.error` | `stored` |
