# Architecture — Toast Usage & Inventory SaaS

Companion to `schema.sql` (data layer) and `data-model.md` (why the tables exist). This document is the *how*: components, pipelines, decisions, and the build order. Written 2026-09-03.

## 1. What we are building, in one paragraph

A read-only analytics layer beside Toast. Every few minutes we pull line-item sales from the Toast Orders API, multiply them by recipes to get theoretical ingredient usage, and combine that with purchases parsed from vendor invoices that arrive by email. The operator sees what was used, what's on hand, what it cost, and where it's leaking — with no manual data entry beyond confirming a pour size or a vendor SKU the first time it shows up. Customer zero is Mad Moose Bar & Grill.

> **Simple build first (2026-09-04).** For Mad Moose alone, the infrastructure in §2–3 and the four workstreams in §8 are more than needed. `CLAUDE.md` and `KICKOFF.md` describe the reduced version: one Next.js app on Vercel with cron routes instead of a Railway worker + pg-boss, inline invoice parsing, Haiku over the full inventory list instead of pgvector, one terminal, three steps. The schema, the pipeline behaviors in §4, and the phase gates are unchanged. Graduate to this document's infrastructure when a cron route starts timing out or a second customer signs.

## 2. Stack decisions

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js (App Router) on Vercel | Existing stack; server components + route handlers; Vercel handles auth callbacks and the UI. **No long-running or large-body work here** (4.5 MB request cap, 10–60 s function limit). |
| Database | Supabase Postgres + Auth + Storage + Vault | `schema.sql` as-is. RLS via `memberships`. Storage bucket `invoices` (private). Vault for Toast client secrets. |
| Workers | One Node/TypeScript service on Railway | Long-running process. Runs the scheduler, the Toast sync, the invoice parser, and the **inbound-email webhook** (attachments can be 10–30 MB — too big for Vercel). |
| Job queue | `pg-boss` on the Supabase Postgres | Retries, cron, singleton jobs, no Redis to operate. Lives in its own `pgboss` schema. |
| LLM | Claude API (Sonnet for parsing/vision, Haiku for cheap classification) | Structured outputs via tool-use schemas. PDF and image input native. |
| Embeddings | `pgvector` + Voyage (or OpenAI) embeddings on `inventory_items.name` | Candidate retrieval for SKU → ingredient matching; Claude reranks the top 5. |
| Inbound email | Postmark Inbound (fallback: Resend Inbound / Cloudflare Email Workers) | Receives on our domain, POSTs JSON with base64 attachments to the worker. Cheapest reliable option; SPF/DKIM handled. |
| Billing | Stripe (per location / month) | Existing stack. Not needed until Phase 3. |
| Repo | Turborepo monorepo (same pattern as the Venezuela network) | Shared types between web and worker. |

## 3. Repo layout

```
xchef/                       (name TBD)
  apps/
    web/                     Next.js — dashboard, review queues, settings
    worker/                  Railway — scheduler, sync, parse, webhooks
  packages/
    db/                      supabase/migrations/*.sql (from schema.sql), generated types, typed query helpers
    toast/                   Toast API client: auth/token cache, ordersBulk pager, menus v2, config
    llm/                     prompts + zod/JSON schemas for menu parse, recipe draft, invoice parse, SKU match
    core/                    pure functions: order flattening, unit math, rollup, mapping resolver (unit-tested, no I/O)
  supabase/                  config, seed, local dev
```

`packages/core` is the important one: everything that turns Toast JSON into `sales_facts` rows, or an invoice line into base units, is a pure function with fixtures. The worker and the web app both import it.

## 4. Components and data flow

```
 Vendors ──email──► Postmark ──webhook──► worker /inbound ──► Storage + invoice_documents(received)
                                                                    │
 Toast POS ◄──ordersBulk / menus v2 (poll)── worker: toast-sync     │ pg-boss jobs
                     │                                              ▼
                     ▼                                    invoice-parse ──► invoice_lines
              toast_orders_raw                            invoice-map   ──► mappings / needs_review
                     │ rollup                                       │ post
                     ▼                                              ▼
               sales_facts ──┐                             purchases_by_item
                             │ × recipe_components                  │
                             ▼                                      ▼
                    usage_by_period ──────────────────────────► on_hand_estimate / count_variance
                             │                                      │
                             └──────────────► Next.js dashboard ◄───┘
```

### 4.1 Toast sync (worker)

**Credentials.** `toast_credentials` per location; `client_secret_encrypted` lives in Supabase Vault, the worker reads it with the service role. Token from `POST /authentication/v1/authentication/login` (`userAccessType: TOAST_MACHINE_CLIENT`), cached in memory until `expiresIn − 60s`. Every request carries `Toast-Restaurant-External-ID: <toast_location_guid>`.

**Order pull.** Cron every 5 minutes per active location (pg-boss singleton per location so runs never overlap):

1. `startDate = last_synced_at − 36h`, `endDate = now`. The overlap is deliberate: Toast recommends `startDate/endDate` because orders are *modified* after creation (voids, refunds, tabs closed the next morning). Re-pulling a window and upserting is cheaper than reasoning about edits.
2. Page `GET /orders/v2/ordersBulk?startDate&endDate&pageSize=100&page=n` following the pagination links; throttle to ≤ 4 req/s per location (Toast's limit is 5).
3. Upsert each order into `toast_orders_raw` keyed `(location_id, order_guid)` with `business_date`, `modified_date`, `voided`, `payload`.
4. Collect the set of `business_date`s touched, then **rebuild `sales_facts` for exactly those dates** from `toast_orders_raw` (delete + insert inside a transaction). This makes the rollup idempotent and lets you re-run any day after a recipe or mapping fix.
5. Set `last_synced_at`.

**Backfill.** On credential creation, enqueue the same job with `startDate = today − 90d` in 7-day chunks. Ninety days of Mad Moose is a few thousand orders — minutes, not hours.

**Flattening rules** (`packages/core/flatten.ts`, unit-tested against real payload fixtures):

- Walk `order.checks[].selections[]`. Skip when `order.deleted` or `check.deleted`.
- Sold quantity = `selection.quantity` unless `selection.voided` or `order.voided` or `check.voided`, in which case it goes to `quantity_voided`.
- Key = `selection.item.guid`. Recurse into `selection.modifiers[]`: a modifier with its own `item.guid` (e.g. "sub Patrón", "add bacon") produces its own row so it can carry its own recipe; modifiers without one are ignored.
- `unitOfMeasure ≠ NONE` (items sold by weight) keeps the decimal quantity as-is.
- Refunds after the fact are **not** subtracted: the product was consumed. (Decision; revisit if refund volume is material.)
- `net_sales = Σ selection.price` for non-voided lines. Informational only.
- Group by `(location_id, item_guid, business_date)` → one `sales_facts` row.

Use Toast's own `businessDate`, never the calendar date of `openedDate` — it already handles the 2 a.m. close.

**Menu sync.** Daily, plus a cheap `GET /menus/v2/metadata` check every sync run; when `lastUpdated` changes, pull `GET /menus/v2/menus` and upsert `menu_items` (GUID, name, price, sales category, modifier options as their own rows). This is also the **recipe-onboarding source**: the menu upload / vision step in `data-model.md` becomes optional, because Toast already gives us every item name and modifier. Menu photos are only for enriching descriptions when Toast names are cryptic ("MARG CL 16").

**Validation gate (Phase 0 exit):** for three business days, `SUM(quantity_sold)` per item must match Toast Web's Product Mix report exactly. Do not build on top of the rollup until it does.

### 4.2 Recipe onboarding (web + worker)

1. After the first menu sync, enqueue `recipe-draft` per menu item: Claude gets item name, category, price, modifier names, and the tenant's existing `inventory_items` list, and returns components (ingredient, quantity, unit, confidence) — creating `inventory_items` it needs. Rows land as `source = ai_draft`.
2. The **Q&A queue** in the app orders items by `units_sold_last_30d × (1 − max_confidence)`, so the margarita is confirmed before the side of ranch. Each card is one question ("How much tequila in a Classic Margarita?") with the AI's guess pre-filled; accept or edit → `confirmed`.
3. Anything confirmed flips `menu_items.recipe_status`. Usage views work immediately for confirmed items and show drafts with a "unconfirmed" badge rather than hiding them.

### 4.3 Invoice ingestion (worker)

**Four intake channels, one pipeline.** Every channel ends as an `invoice_documents` row and goes through the same parse → map → post steps; only `source` differs.

| Channel | `source` | How it lands |
|---|---|---|
| Vendor bills the inbound address directly | `email` | Postmark webhook (below). Zero effort once the vendor's billing email is changed. |
| Operator forwards an email | `forward` | Same webhook; detected by `Fwd:` subject / forwarded headers, original sender recovered for vendor attribution. |
| Scan, photo, or pasted text | `upload` / `paste` | App: drag-drop or phone camera → Storage; pasted text is wrapped as a text document and parsed the same way. |
| Spreadsheet export (`.csv .tsv .xlsx .xls`, ≤ 5 MB) — emailed, forwarded or uploaded | `email` / `forward` / `upload` | Same channels as PDFs. No LLM parse: `lib/jobs/parseSpreadsheet.ts` finds the header row, maps columns (known layout → saved `vendor_sheet_layouts` → Haiku once → header synonyms), writes `invoice_lines` directly, one document per (invoice number, date) group, then map → post. The review screen shows the source rows with editable column roles. |
| Manual intake | `manual` | App form: vendor, date, lines. Skips parsing; goes straight to mapping. For the vendor that only leaves a paper slip. |

**Address.** Resend receives on its default domain today (`INBOUND_EMAIL_ADDRESS`, `…@<id>.resend.app`; any local part → the single location) and on a custom domain via an MX record later, where `invoices-<slug>@` local parts map to `locations.inbound_email_slug`. Resend posts `email.received` (Svix-signed) to `/api/inbound/resend`; attachments are fetched from Resend's API rather than carried in the webhook body. Postmark (`/api/inbound/postmark/[secret]`) is the deprecated predecessor and is removed once Resend has processed 10 real invoices.

**Webhook (`/api/inbound/resend`; the deprecated Postmark route follows the same steps).** Must return 200 fast:

1. Verify the Svix signature (401 otherwise), acknowledge with 200, continue in `after()`. Resolve location from the `To` address; unknown slug → log (never bounce, vendors don't read bounces). Record an `inbound_events` row for every delivery (provider, event, email id, message id, from/to, attachment count, documents created, error).
2. For each attachment that is a PDF, image or spreadsheet: fetch its metadata via `GET /emails/receiving/{email_id}/attachments/{attachment_id}` and download `download_url`; `sha256` → skip if `(location_id, content_hash)` exists; else upload to Storage `invoices/<location>/<yyyy>/<mm>/<hash>.<ext>` and insert `invoice_documents(status='received', source='email' | 'forward', email_from, email_subject, email_message_id)`.
3. No usable attachment but a body (some distributors inline the invoice): fetch it via `GET /emails/receiving/{email_id}` and store the text as a plain-text document for parsing.
4. Guess `vendor_id` from `vendors.email_domains`.
5. Enqueue `invoice-parse(document_id)`.

**Parse job.** Sends the file to Claude with a tool schema:

```
{ is_invoice: bool, document_kind: 'invoice'|'credit'|'statement'|'other',
  vendor_name, invoice_number, invoice_date, received_date?,
  subtotal, tax, total, currency,
  lines: [{ line_no, vendor_sku?, description, pack_size_text?, quantity,
            unit_price?, extended_price?, category_guess, confidence }],
  overall_confidence }
```

- `is_invoice = false` or `document_kind ∈ {statement, other}` → `rejected` (statements would double-count).
- `document_kind = credit` → lines stored with negative quantity (returns reduce purchases).
- Store full output in `raw_extraction`; write `invoice_lines`; check `Σ extended ≈ subtotal` (±2%) and flag if not.
- Vendor: match/insert `vendors` by name; add the sender's domain to `email_domains`.
- Status → `parsing` → then enqueue `invoice-map`.

**Map job** (`packages/core/resolveMapping.ts`). For each line, in order:

1. `(vendor_id, vendor_sku)` hit in `vendor_item_mappings` → `auto_mapped`.
2. `(vendor_id, description_norm)` hit → `auto_mapped`.
3. Otherwise: embed the description, pull top-5 `inventory_items` by cosine similarity, ask Claude (Haiku) to pick one, propose a **new item**, or mark **not inventory** (delivery fee, bottle deposit, tax line) — and to parse `pack_size_text` into `units_per_pack` and `base_units_per_unit` in the target item's base unit (`6/750ML` → 6 × 25.36 oz). Confidence ≥ 0.92 and the item already exists → create an unconfirmed mapping and `auto_mapped`; else `unmapped` for review.
4. `quantity_base_unit = quantity × units_per_pack × base_units_per_unit`; `cost_per_base_unit = extended_price / quantity_base_unit`.
5. Document status: all lines `auto_mapped|confirmed|ignored` → `posted` (+ `posted_at`); otherwise `needs_review`.

**Review queue (web).** One screen: the invoice image on the left, lines on the right, only unresolved lines expanded. Confirming a mapping writes `vendor_item_mappings.confirmed_at` so that SKU never asks again, and re-runs `invoice-map` for the document. Also offers "this isn't an invoice" and "wrong vendor".

**Unit granularity.** Everything is stored in the ingredient's base unit at 4-decimal precision (`numeric(14,4)`), so a 0.1 oz pour or a 0.25 lb portion is exact; recipes can be authored in any compatible unit and `convert_factor()` normalizes. Pack units (case, bottle, #10 can) are only for display and counting, via `pack_to_base_factor`.

**Master unit-cost list.** `unit_cogs_master` is one row per ingredient: latest cost per base unit and per pack, the vendor and date it came from, and the cost currently on file. `item_price_history` behind it gives the trend. This is the "master list of unit COGS" screen.

**Vendor price comparison (headline feature).** Because every line is normalized to cost per base unit, the same ingredient bought from different vendors in different pack formats becomes directly comparable — which is exactly what distributors' packaging is designed to prevent (a case of 3 × 114 oz bags at $67.19 looks close to 6 × #10 cans at $62.50, but is $0.196/oz vs $0.091/oz). Three views: `vendor_price_latest` (latest price per ingredient × vendor × pack format), `vendor_price_comparison` (each option vs the cheapest, premium %), and `vendor_switch_savings` (premium × last-30-day theoretical usage, annualized — so the screen says "switch ketchup to Sysco #10s: ~$1,100/yr"). Two things make it work and both live in the mapping step: the LLM must parse `pack_size_text` into `units_per_pack` × `base_units_per_unit` correctly (the "6/#10" → 6 × N oz kind of knowledge, with a lookup table of standard can sizes, kegs, and bottle formats in `packages/core/packs.ts` — **defaults only**: a size parsed from the invoice or label overrides the table, the owner's edit on the mapping overrides both, and every comparison row displays the assumed base units per pack so a wrong constant is visible, not silent. #10 cans in particular vary by product, roughly 102–128 oz), and mappings carry `brand` so the operator can choose whether Hunt's and Heinz are the same ingredient or two. Surface this as a weekly "you're overpaying for…" list sorted by annualized savings — it's the single most quotable number in a sales demo.

**Price refresh.** After a document posts, set `inventory_items.cost_per_base_unit` to the latest posted `cost_per_base_unit` for that item (simple last-price; weighted average is a later option). This is what makes `usage_cost` and `on_hand_value` real.

**Manual upload** (`/invoices/upload` in the app) uses the same pipeline with `source='upload'` — needed for paper invoices photographed on a phone and for vendors that won't change a billing email.

### 4.4 On-hand, counts, variance (web)

- **Plate cost:** `menu_item_cost` gives every menu item its ingredient cost, cost % of menu price, and whether the recipe and all unit costs are confirmed. Drafted by AI from the menu, verified by the owner in the same Q&A queue as recipes. Feeds menu engineering later.
- **Verification checklist (the reset loop):** the primary "inventory" screen is not a count sheet, it is a list of expectations — "Chicken breast: you should have ~24 lb (about half a case)". `on_hand_estimate.on_hand_packs` renders the pack phrasing. The owner walks the walk-in and taps ✓ (matches) or types what they see. Either writes a `stock_counts` row — ✓ as `verification = 'confirmed_estimate'` with the shown estimate stored in `estimate_at_count`, a typed number as `'counted'` — and because `on_hand_estimate` is a view keyed off the latest count, **the baseline resets and everything downstream recalculates instantly**: purchases and usage are summed only from that point forward. No batch job, no "recalculate" button.
  - **Same-day correctness.** A count carries a `position`: `open` (before service / before deliveries, so that day's sales and deliveries count as *since*) or `close` (after service, so they don't). The app sets it from the local time of the tap (before 2 p.m. → open) and lets the owner flip it. Without this, a mid-morning check would silently drop that day's sales from the estimate forever. Verified in Postgres: open-tap at 297.76 oz, 40 margaritas that day, close-count of 230 oz → variance 7.76 oz over exactly the right window.
  - **What to ask about.** `verification_queue` orders items by how fast you can lose money on them. `daily_burn_value` = usage per day × current cost (expensive × high-volume); `exposure_value` = burn × days since last verified (the dollars that have flowed through since anyone looked, i.e. the size of discrepancy that could be hiding); a `price_change_30d` shock multiplier so that when tomatoes double, the same half-case counts double; never-verified items on top. Each row carries a plain-English `reason` ("price up 100% in 30d", "high $ flow since last check", "stale") and `value_per_pack` so the prompt reads "Tomatoes — check now: price doubled, ~$34/day flowing, a half case is $28." The app shows the top 5–10 per visit so a fast visual check stays fast — the owner eyeballs tomatoes, proteins, and liquor, not toothpicks. The daily digest carries the same list.
  - **Variance in dollars, not units.** `count_variance` reports `variance_value` (at current cost) and `variance_packs`, so a 12.5 lb tomato shortfall shows as "½ case, $28" — and would have shown as $14 a month ago.
  - **Trust signal.** A ✓ is a zero-variance data point by construction; a typed count is real evidence. Both reset the baseline, but variance charts and calibration (pour-size inference) use `verification = 'counted'` rows only.
- **On-hand board:** `on_hand_estimate` per location, grouped by category, with days-of-supply = `on_hand_qty / avg daily usage (14d)` and a reorder flag when < lead time. Items with `has_baseline = false` show "net change since first invoice" and a nudge to count.
- **Count screen:** mobile-first, by storage area, one number per item in the item's *pack* unit (bottles, cases) converted with `pack_to_base_factor`. Saving writes `stock_counts` and immediately shows the variance from `count_variance`.
- **Calibration proposal:** after a count, for any item whose variance exceeds a threshold and which appears in exactly one high-volume recipe, propose the implied pour (`actual_draw / units_sold`) as a `reverse_engineered` component for confirmation.

### 4.5 Alerts (worker, Phase 3)

Daily 7 a.m. digest per location (email now, SMS later): items to reorder, invoices waiting for review, yesterday's usage cost vs sales (pour cost %), and variance since last count. Toast void/discount audit ("who voided what") is the same `toast_orders_raw` table with a different query — cheap add-on.

## 5. Security and tenancy

- RLS on every tenant/location table exactly as `supabase/migrations/20260904002929_rls.sql`; the web app only ever uses the anon key + user JWT.
- Worker uses the service-role key and is the only thing that touches `toast_credentials` and Vault.
- Request only the scopes needed: `orders:read`, `menus:read`, `config:read`, `restaurants:read`. Do **not** request `guest.pi:read` or `delivery_info.address:read` — we don't want guest PII in our database.
- Invoice files are private Storage objects served via short-lived signed URLs.
- Webhook endpoint: secret in path + IP allowlist + size cap; reject anything that isn't Postmark's JSON shape.
- `toast_orders_raw` retention 90 days (payloads are the bulk of storage); `sales_facts` forever.

## 6. Environments and ops

- Supabase: `xchef-dev` (ref gqahyzoebifscqcrrkgq, us-east-1) exists; add `xchef-prod` later. Don't reuse HaltPredict/MacroSeer projects.
- Railway: `worker` service with `WORKER_ROLE=all` for now; split into `sync` and `parse` later if parsing CPU starves the sync loop.
- Vercel: `web`, preview per branch.
- Secrets: `TOAST_*` never in env — per-location in Vault. Env holds `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET`, `VOYAGE_API_KEY`.
- Observability: pg-boss job table is the dashboard; add Sentry to both apps; a `sync_runs` log table (location, window, orders upserted, dates rebuilt, duration, error) is worth adding in Phase 0.
- Running cost at 10 locations: Supabase Pro $25, Railway ~$10, Postmark ~$15, Vercel Pro $20, LLM well under $1/location/month (a restaurant sees 30–80 invoices a month at 2–5¢ each). Price at $49–99/location and margins are fine.

## 7. Build phases

**Phase 0 — Sales truth (week 1).** Monorepo, Supabase project, migrations, auth + tenant/location/membership bootstrap, Toast credential entry, `packages/toast`, sync job, `toast_orders_raw` → `sales_facts`. Exit: three days matching Toast's Product Mix report for Mad Moose.

**Phase 1 — The headline (weeks 2–3).** Menu sync, `recipe-draft`, Q&A queue UI, usage dashboard (`usage_by_period`, `usage_by_menu_item`), inventory item catalog editor. Exit: "72 margaritas → 108 oz tequila" on screen from live data.

**Phase 2 — Receiving with no data entry (weeks 4–5).** Postmark domain + webhook, Storage, parse and map jobs, review queue, manual upload, price refresh, on-hand board, count screen, variance. Exit: a month of Mad Moose invoices posted with ≥ 90% lines auto-mapped and on-hand within a few pours of a real count.

**Phase 3 — Sellable (week 6+).** Self-serve onboarding (create tenant → paste Toast creds → get inbox address), Stripe, daily digest, void/discount audit, menu-engineering quadrant. Then a second restaurant that isn't yours.

## 8. Four parallel workstreams (one per Claude Code terminal)

| # | Workstream | Owns | Depends on |
|---|---|---|---|
| A | **Platform + Toast sync** | monorepo scaffold, `packages/db`, `packages/toast`, worker skeleton + pg-boss, sync job, `packages/core/flatten` + fixtures, `sync_runs` | — |
| B | **Web shell + recipes** | Next.js app, Supabase auth, tenant bootstrap, settings (locations, Toast creds → Vault), inventory catalog, recipe Q&A queue, `recipe-draft` prompt | A's `packages/db` types (day 1) |
| C | **Invoice pipeline** | Postmark setup, `/inbound` webhook, Storage, parse + map jobs, `packages/llm` schemas, `packages/core/resolveMapping` + unit math, pgvector | A's worker skeleton |
| D | **Dashboards + counts** | usage dashboard, on-hand board, count screen, variance view, invoice review queue UI | B's app shell; real data from A |

A goes first by a day so B–D have types and a worker to plug into. C can run entirely on fixture PDFs before any real email arrives — collect a dozen real Mad Moose invoices (Sysco, produce, liquor) as the test corpus on day one.

## 9. Open decisions

- **Product name / domain** — needed for a friendly inbound address (`invoices@…`); the Postmark default address works meanwhile.
- **Weighted-average vs last-price** for `cost_per_base_unit`. Start last-price.
- **Refund handling** — currently "consumed, don't subtract". Confirm.
- **Modifier recipes** — first pass treats "sub Patrón" as a *replacement* only if the operator marks it; default is additive. Needs a `replaces_inventory_item_id` on `recipe_components` eventually.
