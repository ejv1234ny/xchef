# Gate 3 validation — outbound quote requests → forward pricing model

**Status: RUN 2026-09-05** against `xchef-dev` (migration `20260905130000_quotes_forward_pricing` applied; Mad Moose data: 4 vendors, 21 mappings, 0 real quote requests yet).

## What was checked

| # | Gate 3 requirement (KICKOFF-2 Part 3) | How | Result |
|---|---|---|---|
| 1 | `pnpm quotes:request --dry` prints a correct email for each vendor with a contact | `802 Spirits` given a placeholder `contact_email` (`quotes-test@example.invalid`) for the run, removed afterwards | PASS — 3 vendors with mappings composed; 802 Spirits (20 mappings → 20 items after dedupe) ready to send; Coca Cola Beverages Northeast (1 item) and Restaurant Depot (1 item) skipped `no contact_email`. Sysco has no mappings yet and is not asked. `--shock --dry` found the ≥ 10% item (Tequila - Blanco, +122% 30d) and composed the one request for its vendor, 802 Spirits. |
| 2 | The two reply fixtures ingest with correct cost per base unit | `fixtures/quotes/*.txt` parsed by the real model (`lib/llm/invoice-parse.test.ts`, "quote replies"); cost math in `lib/core/quotes.test.ts`; DB write in `lib/jobs/quoteIngest.test.ts` | PASS — see below |
| 3 | `forward_price_model` returns `basis = 'quote'` for those items and `'invoice'` for everything else | `lib/jobs/quoteIngest.test.ts` asserts `basis = 'quote'` for (item, test vendor) and `'invoice'` for every other vendor of the same item | PASS |
| 4 | `purchases_by_item` totals unchanged by quote documents (assert in a test) | same test: row count, Σ quantity_base_unit, Σ cost before vs after posting the quote; `item_price_history` has no row for the quote | PASS |
| 5 | `vendor_switch_savings` shows the quote-based row | same test: the invoiced vendor's row has `cheapest_vendor` = test vendor, `cheapest_basis = 'quote'`, `cheapest_quote_valid_through = 2099-12-31`, `current_basis = 'invoice'` | PASS |

## Fixture parses (real model, gpt-4.1, 1 attempt each)

| fixture | kind | vendor | lines | valid_from → valid_through | first line | specials / minimums | asked-about list leaked? |
|---|---|---|---|---|---|---|---|
| `sysco-quote-reply.txt` (tabular price quote, "-----Original Message-----" quoted below) | quote | Sysco Albany | 6 (= 6 quoted rows; the 7th requested item, PICKLE DILL SPEAR, was not quoted) | 2026-09-08 → 2026-09-30 | #4003330 KETCHUP FANCY TOMATO, 6/#10, $41.85/cs, special_terms "buy 5 cs get 1 free thru 9/30" | #1345612 min_quantity 3 | no |
| `liquor-quote-reply.txt` (plain text "Tito's 750 $41.50/btl, case of 12 $480", "On … wrote:" quote below) | quote | 802 Spirits (Waitsfield) | 6 (Tito's, Beefeater, Jameson, Espolon, Bulleit, Kahlua; the 7th requested item, Diplomatico, was not quoted) | — → 2026-09-30 | Tito's 750, $41.50, special_terms carries the case deal | Jameson "buy 6 get $1 off", Kahlua closeout | no |

Both tests: `corepack pnpm exec vitest run lib/llm/invoice-parse.test.ts -t "quote replies"` → 2 passed (≈ 5 s each, a few cents).

## Cost per base unit (pure, `lib/core/quotes.test.ts`)

| quote line | mapping (units_per_pack × base_units_per_unit) | cost_per_base_unit |
|---|---|---|
| Tito's $41.50 / bottle | 1 × 25.3605 oz | **1.636403 $/oz** |
| Sysco ketchup $62.50 / case | 6 × 106 oz | **0.098270 $/oz** |
| unknown pack (no mapping) | — | null (price kept, no cost; excluded from `vendor_quotes_latest`) |

## Database round trip (`lib/jobs/quoteIngest.test.ts`, runs when `SUPABASE_SERVICE_ROLE_KEY` is set)

Creates a throwaway vendor + mapping (1 × 100 base units) on an ingredient that already has an invoiced price, a `quote_requests` row, a `document_kind = 'quote'` document with one `auto_mapped` line quoted at $1.00/pack, then runs `ingestQuoteLines`:

- 1 `vendor_quotes` row: `cost_per_base_unit = 0.010000`, `special_terms`, `min_quantity = 5`, `valid_through = 2099-12-31`, linked to the request → document `posted`, still `document_kind = 'quote'`.
- `purchases_by_item` for the ingredient: identical row count / Σ qty / Σ cost before and after. `item_price_history`: no row for the quote document.
- `forward_price_model`: `basis = 'quote'`, `expected_next_cost = best_quoted_cost = 0.01`, `last_invoiced_cost = null` for the test vendor; `basis = 'invoice'` for the real vendor(s) of that ingredient.
- `vendor_switch_savings`: the real vendor's row now says switch to the test vendor `on quoted price valid through Dec 31` (`cheapest_basis = 'quote'`).
- Second run: still exactly 1 row (idempotent rewrite). Everything is deleted afterwards.

## Full run

```
corepack pnpm test                       17 files, 149 tests passed (55 s; includes the real-model invoice + quote fixtures)
corepack pnpm exec next typegen && corepack pnpm exec tsc --noEmit    clean
corepack pnpm lint                       clean
```

## How to run (cmd)

```
pnpm quotes:request --dry                      compose without sending (all vendors with mappings)
pnpm quotes:request                            send (Resend), 7-day cooldown per vendor
pnpm quotes:request --vendor "802 Spirits"     one vendor, ignores the cooldown
pnpm quotes:request --shock --dry              only vendors of ≥ 10% / 30d price-shock ingredients
pnpm quotes:request --ingest <document-id>     write vendor_quotes from an upload-channel quote document
```

Cron: `/api/cron/quote-requests` at `0 13 * * 1` (Monday 9 a.m. Eastern) runs the weekly pass then the price-shock pass; `?dry=1` composes only.

## Not yet exercised (needs Eric)

- No vendor has a real `contact_email` yet → Settings → Vendors. Until then nothing is sent and the Prices page button is disabled with a link to Settings.
- A live reply through Resend (`/api/inbound/resend`) has not been received yet; the token → `markQuoteDocuments` → parse → map → `ingestQuoteDocument` path is covered by unit + integration tests, not by a real inbound email.
