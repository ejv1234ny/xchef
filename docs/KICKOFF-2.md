# KICKOFF-2 — Discrepancy engine: daily reconciliation, vendor-portal pull, outbound quotes → forward pricing

Paste everything below the line into Claude Code in `xchef/`. It is written to run unattended: it does not ask questions, it chooses the simplest thing and notes it in the commit message, and it writes a report at the end.

---

You are working in `C:\Users\ejv12\Documents\Claude\Projects\Toast Xtrachef Clone\xchef` on Windows (cmd.exe; give cmd syntax, never bash/PowerShell). Read `CLAUDE.md`, `AGENTS.md`, and `docs/BLUEPRINT.md` first — BLUEPRINT is the product definition and its section 6 invariants are non-negotiable. Then `git pull` (main is ahead of your clone: invoice lines now create their own ingredients, `pnpm invoices:remap` exists, BLUEPRINT and this file exist).

**The goal of this session, in the owner's words:** invoices are what is in inventory — it got delivered. Toast is what sold, itemized down to the modifier. What we are after is the discrepancy between the two, reconciled daily against the fluidity of invoices and the owner's checks. Build the three pieces that make that true, in this order, each one committed and deployed before the next starts. Work autonomously to the end. Do not stop to ask; if genuinely blocked, do everything else first and put the question in the report.

Secrets are in `.env.local` and `.env.toast`. Never print a secret value into a report, a commit, a log line, or chat — a key was leaked that way once already. New env vars go to Vercel with `echo VALUE| vercel env add NAME production` (cmd), then are documented by name only in `.env.example`.

Before every commit: `pnpm test && pnpm typecheck && pnpm lint`. Small commits on `main`; Vercel deploys main. New migrations are `supabase/migrations/2026MMDDHHMMSS_<name>.sql` (0010 onward), applied with `pnpm db:push`, mirrored into `docs/schema.sql`, followed by `pnpm db:types`. Every pure function goes in `lib/core/` with a fixture test; every I/O job in `lib/jobs/`; every route thin. All money and quantity math stays in SQL views or `Decimal` — no floats. Do not touch `lib/toast/`, `flatten.ts`, or the sync jobs: sales truth is out of scope here.

## Part 1 — Daily reconciliation (`daily_position`)

Today `on_hand_estimate` is a live view: correct for "right now," but a Sysco invoice that posts Tuesday for Monday's delivery silently rewrites Monday's discrepancy. Make the discrepancy a daily record that is restated, not erased.

**Migration `daily_position`.** One row per `(location_id, inventory_item_id, business_date)`:
`opening_qty`, `received_qty`, `theoretical_used_qty`, `expected_close_qty`, `counted_qty` (null unless a `counted` stock count landed that day), `variance_qty`, `variance_value`, `cost_per_base_unit` (the cost used for valuation that day), `verification` (`none | confirmed_estimate | counted`), `last_verified_at`, `included_invoice_ids uuid[]`, `included_count_id uuid`, `computed_at`, `restated_at` (null on first computation), `restatement_reason text` (`late_invoice | sales_rebuild | count_backdated | recipe_change | manual`). All quantities `numeric(14,4)`, money `numeric(14,4)`. RLS like every other tenant table. Index on `(location_id, business_date desc)`.

**Pure math in `lib/core/position.ts`.** Given, for one item and one business date: the prior day's `expected_close_qty` (or the baseline from the latest earlier count), the posted invoice lines received that day (in base units), theoretical usage that day (from `usage_by_period` semantics: sales × recipe), an optional count with its `position` (`open` counts set the *opening*; `close` counts set the *close* and produce a variance), and the day's cost — return the row. Encode the same open/close semantics as `on_hand_estimate` and `count_variance` so the daily rows and the live views never disagree; write a fixture test that reproduces the documented case (open-tap 297.76 oz, 40 margaritas, close-count 230 oz → 7.76 oz variance) and a late-invoice restatement case.

**Job `lib/jobs/dailyPosition.ts`.** `runDailyPosition({ locationId, dates? })`: with no dates, compute yesterday's business date (Toast business day; use the location timezone, cutoff 4 a.m. local) *plus* every earlier date that needs restating — any date touched by an `invoice_documents.posted_at` since the last run, any `sales_facts.synced_at` since the last run, any `stock_counts` inserted since the last run with a `counted_at` earlier than the last run's date, and a recipe component confirmed since the last run (restate the trailing 30 days in that case). Compute rows in business-date order so each day's opening is the previous day's close. Upsert; set `restated_at` and `restatement_reason` when overwriting an existing row whose values changed. Record every run in `sync_runs` with `kind = 'daily-position'` (dates computed, rows written, rows restated, duration, error). Idempotent; never crash on one bad item — log and continue.

**Cron.** `/api/cron/daily-position` at `0 9 * * *` UTC (5 a.m. Eastern, after Toast's business-day close and the overnight sync). Add to `vercel.json`. Manual: `pnpm position [--from YYYY-MM-DD --to YYYY-MM-DD]` in `scripts/position.ts`; first run backfills from the earliest posted invoice or the earliest `sales_facts` date, whichever is later.

**Surface it.** On the verify page (home), each queue row gets one extra line: "as of close yesterday: expected X packs · last checked N days ago" read from `daily_position`, and if yesterday's row was restated, a small "restated (late invoice)" tag. Add `/position` (phone-first) showing the last 14 days for one ingredient as a table: date, opening, received, used, expected close, counted, variance $ — with restated days marked. `verification_queue` may now read staleness from `daily_position.last_verified_at`; only do that if it simplifies the view, otherwise leave the view alone.

**Gate 1.** `pnpm position` backfills without error; for at least three consecutive days, `daily_position.expected_close_qty` for the latest day equals `on_hand_estimate.on_hand_qty` for every item that has a baseline (write `scripts/validate-position.ts` that asserts this and appends to `docs/validation/position.md`). Post one fixture invoice dated three days back via `pnpm invoices:replay`, re-run `pnpm position`, and confirm those three days are restated with reason `late_invoice`.

## Part 2 — Vendor-portal pull (fifth intake channel, `source = 'api'`)

Paper arrives at delivery; the authoritative copy appears on the vendor's portal the next day. Add a scheduled pull that downloads it into the same intake → parse → map → post pipeline. The `invoice_source` enum already has `api`; the job does not exist.

**Where it runs.** Not on Vercel — a browser doesn't fit a 300 s function. Create `.github/workflows/portal-pull.yml`: daily at `0 11 * * *` UTC (7 a.m. Eastern, portals are posted by then), `ubuntu-latest`, `pnpm install`, `npx playwright install --with-deps chromium`, `pnpm portal:pull`. Credentials are GitHub Actions secrets named `PORTAL_<VENDOR>_USER` / `PORTAL_<VENDOR>_PASS` plus `XCHEF_INTAKE_KEY` and `XCHEF_BASE_URL`. Add `playwright` as a devDependency only.

**Intake auth.** `/api/intake/upload` currently requires a user session. Add a second path: header `x-intake-key` equal to env `INTAKE_API_KEY` (generate with `openssl rand -hex 32` equivalent in node, add to Vercel) marks the document `source = 'api'` and resolves the location by `?location=<id>` (default: the first location). Keep the session path unchanged.

**Adapters.** `lib/portals/<vendor>.ts` each exporting `pull({ page, since }): Promise<Array<{ invoiceNumber, invoiceDate, buffer, mime, filename }>>`. Write the first two for the vendors with the most invoice volume in `invoice_documents` — expect Performance Food Group (customer portal) and Sysco Shop; if a portal offers "email my invoices" or a CSV/PDF export by date range, say so in the adapter's header comment and prefer the export over screen-scraping. Selectors will be wrong on first write — that is expected. Make each adapter fail loudly with a screenshot saved to the workflow artifacts, never silently return zero. `scripts/portal-pull.ts` iterates vendors whose credentials are set, pulls since `max(invoice_date) − 3 days` for that vendor, and POSTs each file to the intake endpoint.

**Dedupe and attach.** In `lib/jobs/intake.ts`, when an `api` document arrives and a document with the same `(vendor_id, invoice_number)` already exists: store the new file as `clean_storage_path` on the existing document (add the column), do not create a second document, and if the existing one was a photo/scan (`source in ('upload','forward')` with an image mime), re-parse from the clean copy with `reparse=true`; if the new parse's line totals match the posted lines within one cent, keep the posted lines and mark `verified_by_clean_copy_at`; otherwise set `needs_review` with a `parse_diff` jsonb the review page renders as "paper said / portal says." Record the outcome in `inbound_events` with provider `portal`.

**Gate 2.** The workflow runs green on `workflow_dispatch` with at least one adapter against real credentials (Eric will add the secrets; if they are absent when you get here, the gate is: workflow green in a dry-run mode that exercises the intake auth with a fixture PDF and the attach/dedupe path end to end, and the report says which secrets are needed).

## Part 3 — Outbound quote requests → forward pricing model

Invoiced prices are history; quotes are the future. Run the invoice machinery in reverse.

**Schematic — forward pricing.**

```mermaid
flowchart LR
  VIM[(vendor_item_mappings<br/>what each vendor supplies, in which pack)] --> REQ[quote request<br/>weekly, or on price shock ≥ 10% / 30d]
  REQ -->|Resend send, reply-to = inbound address| VENDOR[Vendor sales rep]
  VENDOR -->|reply: PDF / sheet / plain text| INBOX[/api/inbound/resend]
  INBOX --> PARSE[invoice parser<br/>document_kind = quote]
  PARSE --> MAP[same map step<br/>vendor SKU → ingredient, pack → base units]
  MAP --> VQ[(vendor_quotes<br/>never posts purchases)]
  INV[(invoice_lines · posted)] --> IPH[item_price_history]
  IPH --> FPM[forward_price_model view]
  VQ --> FPM
  FPM --> CMP[vendor_price_comparison<br/>invoiced vs quoted per vendor]
  CMP --> SAV[vendor_switch_savings<br/>on the price you would actually pay next]
  SAV --> PRICES[/prices page · order-guide recommendation]
```

| Object | Role |
|---|---|
| `quote_requests` | one row per email sent: `vendor_id`, `sent_at`, `resend_message_id`, `items jsonb` (mapping ids + descriptions asked about), `status` (`sent`, `replied`, `no_reply`), `reply_document_id` |
| `vendor_quotes` | one row per quoted line: `tenant_id`, `vendor_id`, `inventory_item_id`, `mapping_id`, `vendor_sku`, `description`, `pack_description`, `units_per_pack`, `base_units_per_unit`, `quoted_unit_price`, `cost_per_base_unit`, `special_terms text`, `min_quantity`, `valid_from`, `valid_through`, `source_document_id`, `received_at`; a partial unique index on the latest per `(vendor_id, mapping_id)` |
| `invoice_documents.document_kind = 'quote'` | parsed like an invoice, mapped like an invoice, **never posted**; lines are written to `vendor_quotes`, not `invoice_lines` purchases (they may live in `invoice_lines` for the review UI, but `purchases_by_item` must exclude quote documents) |
| `forward_price_model` (view) | per ingredient × vendor: `last_invoiced_cost`, `last_invoiced_at`, `best_quoted_cost`, `quote_valid_through`, `expected_next_cost` = quoted if valid today else invoiced, `trend_30d_pct` from `item_price_history`, `basis` (`quote` / `invoice`) |
| `vendor_price_comparison`, `vendor_switch_savings` | recomputed on `expected_next_cost`; keep the existing invoiced-only columns so nothing that reads them breaks; add `basis` |

**Request send.** `lib/jobs/quoteRequest.ts`: for each vendor with ≥ 1 confirmed or auto mapping and an email on `vendors.contact_email` (add the column; Eric fills it in Settings → Vendors), compose a plain-text email from the location's name listing the items (vendor SKU + description + pack as we know them) and asking for current price per pack, any specials or case-deal pricing, and price validity dates; ask for the reply as a PDF or spreadsheet if they have one, otherwise inline. Send with Resend (`RESEND_API_KEY`, already set) from a sending identity on the Resend domain, `reply-to` = `INBOUND_EMAIL_ADDRESS` so replies land in the existing webhook. Subject carries a token `[Q-<short id>]` so the reply threads to its `quote_requests` row. Cron `/api/cron/quote-requests` at `0 13 * * 1` (Monday 9 a.m. Eastern); also enqueue a request for any vendor whose ingredient shows `price_change_30d ≥ 10%` in `verification_queue`, at most once per vendor per 7 days. Manual: `pnpm quotes:request [--vendor <name>] [--dry]`.

**Reply ingestion.** In the Resend webhook, a message whose subject or `In-Reply-To` carries `[Q-…]`, or whose parser output says `document_kind = quote`, becomes a quote document: parse (extend the invoice-parse schema with `document_kind: 'quote'`, `valid_from`, `valid_through`, and per-line `special_terms`, `min_quantity`; plain-text replies are parsed from the body), map through the existing mapping step, write `vendor_quotes`, link `quote_requests.reply_document_id`, mark `replied`. Fixture: write two synthetic reply fixtures (one PDF-style structured, one plain-text "Tito's 750 $41.50/btl, case of 12 $480 through 9/30") with expected JSON.

**Prices page.** `/prices` gets a second number per vendor column (quoted, with valid-through) and the savings row states its basis: "switch ketchup to Sysco #10s: ~$1,100/yr on quoted price valid through Sep 30." Add an "Ask for pricing" button per vendor that calls the request job for that vendor.

**Gate 3.** `pnpm quotes:request --dry` prints a correct email for each vendor with a contact; the two reply fixtures ingest into `vendor_quotes` with correct cost per base unit; `forward_price_model` returns `basis = 'quote'` for those items and `'invoice'` for everything else; `purchases_by_item` totals are unchanged by quote documents (assert in a test); `vendor_switch_savings` shows the quote-based row.

## Part 0 (do first, ten minutes) — one template debt

`lib/llm/recipe-draft.ts` hardcodes "a bar & grill in Vermont …" in `RECIPE_DRAFT_SYSTEM`. Add `tenants.concept text` (migration, default null), read it in the recipe-draft job, fall back to the current sentence when null, and set Mad Moose's row to the current sentence. One commit.

## Finish

Write `docs/REPORT-2.md`: what was built (file by file), each gate's result with the actual numbers, every assumption you made, every secret or setting Eric still has to provide (names only), and the exact cmd commands to run the three manual scripts. Update `CLAUDE.md` layout and rules for the new tables, jobs, crons, and the GitHub Actions workflow; update `docs/BLUEPRINT.md` section 5 and 11 so nothing there says "planned" that now exists. Commit, push, confirm the Vercel deployment is READY, and stop.
