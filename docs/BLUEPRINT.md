# The Invoice-Root Blueprint

**An end-to-end architecture for a usage & inventory layer beside a POS — built once for Mad Moose Bar & Grill, written so the next restaurant (or the next kind of SMB) is a configuration, not a rebuild.**

Reference implementation: `ejv1234ny/xchef` · live at xchef.vercel.app · written 2026-09-05 against commit `1bfe2f0`. Companion documents: `CLAUDE.md` (the build rules), `docs/architecture.md` (behavior of each piece), `docs/data-model.md` (why each table exists), `docs/schema.sql` (the data layer).

---

## 1. The one principle

Every ingested invoice or receipt is the basis for everything downstream. There is no catalog to set up, no ingredient list to maintain, no pack-size table an owner fills in. The invoice *is* the catalog; each later dataset is the same invoice data parsed differently:

| Stage | Dataset | How it is derived from invoices |
|---|---|---|
| 1 | Ingredient catalog (`inventory_items`) | A line the matcher has never seen creates the item — name, category, base unit — the moment it is mapped |
| 2 | Pack sizes (`vendor_item_mappings`) | Parsed from the line's pack text (`12/750ML`, `6/#10`, `3/114OZ`); a per-vendor fact, never a global constant |
| 3 | Unit COGS (`unit_cogs_master`, `item_price_history`) | Extended price ÷ base units on the line; refreshed every time a document posts |
| 4 | Vendor price comparison (`vendor_price_comparison`, `vendor_switch_savings`) | The same ingredient from two vendors, both normalized to cost per base unit |
| 5 | Menu-item cost (`menu_item_cost`) | Recipe components × the unit costs from stage 3 |
| 6 | On-hand and variance (`on_hand_estimate`, `count_variance`) | Purchases from stage 1–2 plus sales × recipes, against the last verified count |

Sales are the *multiplier*, not the root: the POS tells you how many margaritas sold; the invoices tell you what a margarita costs and what a case of tequila contains. A system that starts from a hand-built catalog inverts this and puts a data-entry step in front of every value.

What the whole thing is *for* is one number per ingredient: the discrepancy. Invoices say what was delivered, so they are what is in inventory. Toast says what was sold, itemized down to the modifier. The running inventory is delivered − sold, and the owner's checks are the moments that number is tested against the walk-in. Everything else — catalog, packs, COGS, price comparison, plate cost — exists so that the discrepancy can be stated in dollars and in packs and be trusted.

Corollary that shaped the build: **parse quality is the whole game.** A bad parse poisons every stage below it, so the fix is always at the parser (a vendor-specific layout), never a hand-edit to a catalog row. Mad Moose's Coca-Cola bag-in-box delivery ticket is the standing example — its lines came out as category labels rather than products and produced one merged "Juice Drink" item; it stays in review until the parser reads that ticket format correctly.

---

## 2. The system in one picture

```mermaid
flowchart LR
  subgraph intake[Intake — five channels, one pipeline]
    E[Vendor emails invoice] --> W[/api/inbound/resend]
    F[Owner forwards email] --> W
    P[Phone photo / scan / paste] --> U[/api/intake/upload · paste]
    M[Manual form] --> U
    V[Vendor portal pull · GitHub Actions daily] --> U
  end
  W --> D[(invoice_documents)]
  U --> D
  D --> PARSE[parse<br/>LLM structured output<br/>or spreadsheet layout]
  PARSE --> L[(invoice_lines)]
  L --> MAP[map<br/>saved mapping → fee/deposit → LLM sku-match<br/><b>new product ⇒ create inventory_item</b>]
  MAP --> POST[post<br/>all lines resolved ⇒ posted<br/>refresh cost_per_base_unit]
  POST --> PBI[(purchases_by_item)]
  Q[Quote requests out weekly · replies in] --> PARSE
  STK[Toast Stock every 5 min<br/>86-list events] --> VQ
  LAB[Toast labor daily<br/>labor_entries] --> COST[daily_cost_summary<br/>pour cost + labor % of sales]

  subgraph pos[POS — read-only pull]
    T[Toast ordersBulk<br/>every 5 min, 36 h overlap] --> RAW[(toast_orders_raw)]
    RAW --> SF[(sales_facts<br/>rebuilt per business date)]
    T2[Toast menus v2<br/>daily] --> MI[(menu_items)]
  end

  MI --> RD[recipe draft<br/>LLM + Q&A queue] --> RC[(recipe_components)]
  SF --> USE[usage_by_period<br/>sales × recipe]
  RC --> USE
  PBI --> OH[on_hand_estimate<br/>last count + purchases − usage]
  USE --> OH
  OH --> VQ[verification_queue<br/>$ burn × staleness × price shock]
  VQ --> PHONE[Verify screen<br/>✓ or typed count → baseline resets]
  PHONE --> SC[(stock_counts)] --> OH
```

Everything to the right of the tables is a SQL view. App code reads views; it never recomputes money or quantity.

---

## 3. Stack — the simple build

One Next.js app, one Postgres, no worker, no queue, no monorepo. It has carried a full restaurant's data without strain; graduate only when a cron route times out or a second tenant signs.

| Layer | Choice | Notes for the next build |
|---|---|---|
| App | Next.js 16 App Router, TypeScript strict, Tailwind v4, PWA | Vercel Pro (cron + 300 s functions). Designed at 390 px first; desktop is the same layout wider |
| Database | Supabase Postgres + Auth (magic link) + Storage (`invoices`, private) + Vault | RLS via `memberships`; views are `security_invoker` |
| POS | Toast Standard API (read-only, location-scoped) | `orders:read menus:read config:read restaurants:read`. Never the Analytics API, never guest-PII scopes. Client secret in Vault, read only by service-role code |
| LLM | Provider-agnostic behind `lib/llm/provider.ts` — OpenAI (gpt-4.1 parse/draft, gpt-4.1-mini match) or Claude (Sonnet/Haiku) | Temperature 0, strict JSON-schema output, model ids pinned, every call logged to `llm_calls` with tokens and cost |
| Inbound email | Resend receiving → Svix-signed webhook | Address on Resend's default domain now; custom MX later so each location gets `invoices-<slug>@` |
| Scheduling | Vercel Cron → route handlers, GitHub Actions for the browser job | `/api/cron/toast-sync` */5 min (orders + 86-list), `/api/cron/daily-sync` daily (menus + labor), `/api/cron/daily-position` daily, `/api/cron/quote-requests` Mondays; `.github/workflows/portal-pull.yml` daily. Each run short and idempotent |
| Tests | Vitest on `lib/core/*` from fixtures | The pure functions — flattening, units, packs, mapping — are the only things that need tests, and every one has them |

Running cost at one location: Supabase $10, Vercel Pro $20, LLM under $1/month (a restaurant sees 30–80 invoices a month at 2–5¢ each; a full recipe drafting pass on 700 menu items is a few dollars once). Toast Standard API access is the operator's own ~$50/month tier — no partner agreement, no approval.

---

## 4. Data model

Eighteen tables and twelve views. The tables are cheap; the views are where the product lives.

**Tenancy.** `tenants` → `locations` → `memberships`. One management group is a tenant; one Toast restaurant GUID is a location. Every tenant-scoped row carries `tenant_id` (or `location_id`) and RLS filters on membership. The schema is multi-tenant from day one even though the app serves one tenant.

**POS side.** `toast_credentials` (Vault-backed), `toast_orders_raw` (full payload, 90-day retention), `sales_facts` (one row per item per business date: `quantity_sold`, `quantity_voided`, `net_sales`), `menu_items` (from menus v2, modifier options as their own rows), `sync_runs` (every run's window, counts, duration, error).

**Invoice side.** `vendors` (+ `email_domains`, `kind` — e.g. `retail_liquor` changes how packs are inferred), `invoice_documents` (status `received → parsing → needs_review | posted | rejected`; source `email | forward | upload | paste | manual | api`), `invoice_lines` (status `unmapped | auto_mapped | confirmed | ignored`; `quantity_base_unit`, `cost_per_base_unit`), `vendor_item_mappings` (the learned fact "this vendor's SKU is this ingredient in this pack"), `vendor_sheet_layouts` (remembered spreadsheet column maps by header fingerprint), `inbound_events` (every webhook delivery), `llm_calls`.

**Recipes and stock.** `inventory_items` (`base_unit`, `pack_to_base_factor`, `cost_per_base_unit`), `recipe_components` (`source = ai_draft | reverse_engineered | confirmed`, `confidence`), `stock_counts` (`verification = confirmed_estimate | counted`, `position = open | close`, `estimate_at_count`).

**The views, in dependency order.**

| View | Answers |
|---|---|
| `usage_by_period`, `usage_by_menu_item` | "72 margaritas → 108 oz tequila" — sales × recipe per ingredient, per menu item |
| `purchases_by_item` | Posted invoice lines in base units, per ingredient |
| `item_price_history` → `unit_cogs_master` | Cost per base unit and per pack over time; the master COGS list |
| `vendor_price_latest` → `vendor_price_comparison` → `vendor_switch_savings` | Same ingredient across vendors and pack formats; premium vs cheapest; annualized savings at current usage |
| `menu_item_cost` | Plate cost, cost % of menu price, whether recipe and unit costs are all confirmed |
| `on_hand_estimate` | Last count + purchases since − usage since, in base units and packs |
| `count_variance` | Between consecutive counts: unexplained depletion in units, packs, and dollars |
| `verification_queue` | What to check next, ordered by daily $ burn × days since verified × (1 + 30-day price change), with a plain-English reason |

Two conventions make the views trustworthy: every quantity is stored in the ingredient's `base_unit` as `numeric(14,4)` (pack units are display and counting only), and money never touches a float — `numeric` in Postgres, `Decimal`/strings in TypeScript until render.

---

## 5. The pipelines

### 5.1 Sales sync (POS → `sales_facts`)

Every five minutes per location: window `last_synced_at − 36 h → now` (Toast modifies orders after creation — voids, refunds, tabs closed the next morning — so re-pulling a window and upserting beats reasoning about edits), page `GET /orders/v2/ordersBulk` at ≤ 4 req/s, upsert `toast_orders_raw`, then **rebuild `sales_facts` for exactly the business dates touched** in one transaction (`replace_sales_facts` RPC). Idempotent; any day can be re-run after a recipe or mapping fix. First run backfills 90 days in 7-day chunks, at most three chunks per invocation so a function limit never loses progress.

Flattening rules (`lib/core/flatten.ts`, fixture-tested): skip deleted orders and checks; voided at any level → `quantity_voided`; a modifier with its own `item.guid` ("sub Patrón", "add bacon") is its own row so it can carry its own recipe; weight-sold items keep decimal quantities; refunds are not subtracted (the product was consumed); always Toast's `businessDate`, never the calendar date of `openedDate`.

Menu sync runs daily and on `lastUpdated` change; after it, `relink_sales_facts` re-points historical facts at the current `menu_item_id`.

**Gate.** Three business days where `sales_facts` matches Toast Web's Product Mix report per item (`pnpm pmix`, `scripts/validate-pmix.ts`). Nothing is built on the rollup until this passes.

### 5.2 Invoice intake (five channels → one pipeline)

| Channel | `source` | Lands via |
|---|---|---|
| Vendor bills the inbox directly | `email` | Resend webhook; zero effort once the vendor's billing address is changed |
| Owner forwards | `forward` | Same webhook; original sender recovered for vendor attribution |
| Phone photo, scan, PDF, pasted text | `upload` / `paste` | App; camera is the primary intake, client-side resize ≤ 2000 px, HEIC accepted |
| Spreadsheet export (`csv tsv xlsx xls`) | any of the above | Deterministic column mapping, no LLM parse; unknown headers mapped once and remembered |
| Paper slip typed in | `manual` | Form; skips parsing, goes straight to map |
| Vendor portal pull | `api` | GitHub Actions (`.github/workflows/portal-pull.yml`, daily 11:00 UTC) runs `scripts/portal-pull.ts`: one Playwright adapter per portal in `lib/portals/` (PFG and Sysco Shop first) logs in, downloads invoices since the last one on file, and POSTs each to `/api/intake/upload` with the `x-intake-key` header. Every arrival is an `inbound_events` row with provider `portal`. Portals that ask for a one-time code are logged into once by hand (`pnpm portal:login`) and the saved browser session is reused from a GitHub secret. Adapters are best-effort against portals we have no test account for: they screenshot and fail loudly rather than return an empty list. The workflow's dry run (create → dedupe → attach against production) is green; the adapters await real credentials (`docs/REPORT-3.md` §7) |

The paper/portal lag is handled by the pipeline's own dedupe rather than a rule: the delivery driver hands over paper, the owner photographs it at the door (`upload`, same day, on-hand is right immediately), and the portal posts the authoritative copy the next morning (`api`). Both resolve to the same `(vendor, invoice_number)`; the second arrival attaches to the first document as its `clean_storage_path` rather than creating a second purchase. When the paper copy was a photo or scan, the clean copy is parsed and compared with the posted lines: a match within one cent sets `verified_by_clean_copy_at`; a mismatch stores `parse_diff` ("paper said / portal says") and sends the document back to review. Where a portal offers "email me my invoices" that setting is preferred over automation — zero maintenance beats a login script that breaks when the portal redesigns — and the browser job is the fallback for vendors that don't.

The webhook returns 200 fast, never bounces (vendors don't read bounces), dedupes on `content_hash` and `email_message_id`, and does the work in `after()`.

**Parse.** Structured output: `documents[]` (a scan can hold several receipts), each with vendor, number, date, subtotal/tax/total, `document_kind` (invoice | credit | statement | other), and lines with SKU, description, pack text, quantity, unit and extended price, category guess, confidence. Statements → `rejected` (they double-count). Credits → negative quantities. Discounts under an item are that line's `adjustment`, never a line. Every document is validated (Σ lines = printed subtotal; line count or quantity = printed count) with one model retry; the line sum is the trusted number when OCR disagrees by cents. Retail liquor receipts count bottles: size from the item name, else 750 ml assumed and flagged.

**Map** (`lib/core/resolveMapping.ts` pure; `lib/jobs/mapInvoice.ts` does I/O). Per line, in order: saved `(vendor, sku)` mapping → saved `(vendor, normalized description)` → fee/deposit/tax category → LLM sku-match against the *whole* inventory list (a restaurant has a few hundred items; no vector DB). The matcher returns one of three verdicts:

- **existing** at confidence ≥ 0.92 with a known pack → `auto_mapped`, unconfirmed mapping written so the next invoice from that vendor never asks;
- **new** with a known pack → **the inventory item is created from the line** (name, category, base unit from the matcher; `pack_to_base_factor` from the invoice), the line is `auto_mapped`, the mapping is unconfirmed so review can rename or merge in one tap;
- **not inventory** → `ignored`.

Anything else (low confidence, unknown pack) → `unmapped`, with the proposal kept for the review screen. Pack sizes are never hardcoded: `lib/core/packs.ts` holds *defaults*; a size parsed from the invoice overrides them; the owner's edit on the mapping overrides both; every price row displays the assumed base units per pack so a wrong constant is visible, not silent. Then `quantity_base_unit = quantity × units_per_pack × base_units_per_unit` and `cost_per_base_unit = extended ÷ quantity_base_unit`.

**Post.** When every line is `auto_mapped | confirmed | ignored` and at least one is mapped, the document is `posted` and `inventory_items.cost_per_base_unit` is refreshed from the latest posted line (last price; weighted average is a later option). Only posted lines count as purchases.

### 5.3 Recipes (menu → `recipe_components`)

After menu sync, an LLM drafts components per menu item from name, category, price, modifier names, and the tenant's inventory list, creating items it needs, as `source = ai_draft` with confidence. The Q&A queue orders items by `units_sold_last_30d × (1 − max_confidence)` so the margarita is confirmed before the side of ranch; each card is one question with the guess pre-filled. Usage views work immediately for confirmed recipes and show drafts with an "unconfirmed" badge rather than hiding them. Between two real counts, `count_variance` lets the system back out an implied pour (actual draw ÷ units sold) and propose it as `reverse_engineered` for confirmation.

### 5.4 Outbound pricing (the forward price model)

Invoiced prices are history; quotes are the future. The same machinery runs in reverse: on a schedule (weekly, or when an ingredient's 30-day price change exceeds a threshold) the system emails each vendor a request for current pricing on the items that vendor supplies, plus any specials or case-deal discounts, from the location's own inbound address so replies land in the same webhook. A reply is parsed by the invoice parser with `document_kind = quote`: it never posts purchases and never touches on-hand, but its lines map through the same vendor SKU / description mappings into a quotes dataset keyed by ingredient, vendor, pack, price, and valid-through date. `vendor_price_comparison` then has two columns per vendor — last invoiced and last quoted — and `vendor_switch_savings` can be computed on quoted prices, which is the number to act on before the order goes in rather than after the invoice arrives. Built (2026-09-05, sender identity 2026-09-06): `lib/jobs/quoteRequest.ts` sends as the restaurant itself — `RESEND_FROM_NAME <quotes@RESEND_FROM_DOMAIN>`, signed by the owner's first name from `tenants` — with the inbound address as reply-to and a `[Q-token]` in the subject (`quote_requests`); while the restaurant's domain is not verified in Resend the request is held as `status = 'blocked_sender'` rather than sent from someone else's domain; Mondays by cron, or on demand from the prices page ("Ask for pricing") and `pnpm quotes:request`, and automatically for vendors of ingredients whose 30-day price change is ≥ 10 %. A reply is recognised by the token, parsed with `document_kind = 'quote'` (validity dates on the document, `special_terms` / `min_quantity` on lines), mapped through the same vendor mappings, and written to `vendor_quotes`. `purchases_by_item` and `item_price_history` exclude quote documents; `forward_price_model` gives, per ingredient × vendor, the last invoiced cost, the best valid quoted cost, `expected_next_cost` and its `basis`; `vendor_price_comparison` and `vendor_switch_savings` rank on that expected next cost and say which basis produced each number.

### 5.5 The verification loop (the inventory screen)

The primary screen is not a count sheet. It is a short list of expectations in pack units — "Tomatoes: you should have ~24 lb (about half a case)" — ordered by `verification_queue.priority_score`, top 5–10 per visit. A ✓ tap writes `stock_counts` as `confirmed_estimate` with the shown estimate stored; a typed number writes `counted`. Either resets the baseline instantly because `on_hand_estimate` is a view keyed off the latest count — no batch job, no recalculate button. `position` (open before 2 pm local, close after; owner can flip) decides whether that day's sales and deliveries count as "since". Only `counted` rows feed variance charts and calibration; a ✓ is zero-variance by construction.

**86-list** (built 2026-09-06). The five-minute sync also reads Toast Stock (`GET /stock/v1/inventory`, read-only) and appends only changes to `menu_item_stock_events` — events, not snapshots. An ingredient whose top menu item is out of stock shows "86'd since Fri 8:40 pm" on the verify screen, and `daily_position.stockout_minutes` records how long its menu items were 86'd that business day, so a low-usage day reads as explained rather than as variance.

**Labor beside pour cost** (built 2026-09-06). Toast time entries (`GET /labor/v1/timeEntries`, employee guid and job title only) land in `labor_entries` daily with a 36-hour re-pull; `daily_labor` and `daily_cost_summary` put labor cost and labor % of net sales beside the theoretical pour/food cost on `/position`.

**Catalog pruning** (built 2026-09-06). Every `inventory_items` row carries its `origin` (`invoice | recipe_draft | manual`) and `first_invoiced_at`; `catalog_health` classifies each item `confirmed | pending | orphan | dormant | archived`, and `/inventory` lets the owner merge a never-invoiced draft into the item that owns its history or archive it in one tap (`merge_inventory_item()`; archived items leave the verify queue and the reconciliation, never the database). A deterministic name-match guard (`lib/core/nameMatch.ts`) makes an invoice line land on the draft-born item of the same name instead of creating a duplicate.

**Daily reconciliation** (`daily_position`, built 2026-09-05). Once a day (09:00 UTC cron, `pnpm position`) the system writes one row per (location, ingredient, business date): opening (yesterday's expected close, or the latest count baseline), received (posted invoice lines), theoretical use (`usage_by_period`), expected close, the count if there was one, and the variance in units and dollars at that day's cost. It is the discrepancy as a record rather than a live view: when a late invoice posts, sales are rebuilt, a count is backdated or a recipe changes, the affected days are recomputed and marked `restated_at` / `restatement_reason` (`late_invoice | sales_rebuild | count_backdated | recipe_change`), never deleted. `scripts/validate-position.ts` proves that yesterday's expected close equals `on_hand_estimate` for every item with a baseline; the verify screen shows each item's position as of last close and a "restated" tag when it moved; `/position` shows the last 14 days per item.

---

## 6. Invariants — the rules that made it work

These are the rules in `CLAUDE.md`, restated as the things a second build must not relax:

1. Sales from `ordersBulk`, menus from `menus/v2`, read-only scopes only. The POS is never written to.
2. Rebuild `sales_facts` per touched business date in one transaction. Never patch.
3. All money and quantity math in SQL views. App code reads; it never recomputes.
4. Base units everywhere, `numeric(14,4)`, no float math anywhere in the path from invoice to screen.
5. Never hardcode a pack size; always show the assumption.
6. Every intake channel — including a portal pull or a quote reply — produces an `invoice_documents` row and goes through the same parse → map → post. Post only when every line is resolved.
7. A "new" product creates its ingredient. The catalog is derived, never seeded.
8. Zod at every boundary (POS payloads, LLM output, webhooks). Quarantine and log failures; never crash a cron run.
9. Fixture tests for the pure core from the tenant's real data. A change there without a fixture is not done.
10. Phone first: 44 px targets, one-thumb verify and review screens, camera intake, PWA-installable, top-10 list server-rendered in < 1 s on 4G.
11. The discrepancy is reconciled daily, not just computed live. A business-day-close job (`daily_position`) materializes each ingredient's opening, received, sold-through-recipe, expected close, last verification and minutes 86'd, and *restates* a past day when a late invoice posts — so fluidity is recorded, never erased.
12. The catalog is pruned, never seeded: an item is invoice-born, draft-born or manual, and a draft the invoices never confirm is merged or archived, not left to pollute the verify queue.

---

## 7. What changes per restaurant

Standing this up for a second Toast restaurant is configuration plus one afternoon of parser attention. The swap points, in the order they are touched:

| Swap point | Where it lives | Mad Moose value | Notes |
|---|---|---|---|
| Tenant, location, timezone | `tenants`, `locations` | Mad Moose Bar & Grill, `America/New_York` | Timezone drives the open/close position cutoff |
| Toast credentials + restaurant GUID | Vault via `set_toast_credentials`; `locations.toast_location_guid` | one location | Operator self-generates in Toast Web → Integrations → API access. `pnpm creds` reads `.env.toast` |
| Inbound address | `INBOUND_EMAIL_ADDRESS` now; `locations.inbound_email_slug` with a custom MX later | `invoices@<id>.resend.app` | The only thing vendors need to be told |
| Vendors and their kinds | `vendors.kind`, `vendors.email_domains` | Sysco, PFG, Restaurant Depot, Farrell, 802 Spirits (`retail_liquor`), Coca-Cola NE | `kind` selects parse/pack behavior; new kinds are a code change, new vendors are rows |
| Vendor document layouts | `lib/llm/invoice-parse.ts` prompt + fixtures; `lib/core/sheets.ts`; `vendor_sheet_layouts` | Restaurant Depot xlsx layout; retail liquor bottle inference | **The main per-tenant engineering.** Budget one fixture + one expected JSON per new vendor format |
| Pack defaults | `lib/core/packs.ts` `DEFAULT_PACKS` | #10 cans, kegs, bottle formats, bag sizes | Shared; extend, don't fork |
| Recipe prompt context | `lib/llm/recipe-draft.ts` `RECIPE_DRAFT_SYSTEM` | "a bar & grill in Vermont (burgers, wings, … classic cocktails)" | **Currently hardcoded — should move to `tenants.concept` or a per-tenant prompt fragment before tenant two** |
| Inventory categories | `lib/llm/recipe-draft.ts` `INVENTORY_CATEGORIES` | produce, protein, dairy, dry, liquor, beer, wine, beverage, … | Fine for restaurants; adjacent verticals extend the enum |
| Verification cutoff, thresholds | `verification_queue`, app constants | 2 pm open/close; top 10 | Sensible defaults; expose in settings when tenant two asks |
| Tax and gratuity | not modeled — invoices carry their own tax lines (`ignored`) | VT meals 10 % / alcohol 11 % on the sales side | Sales-side tax is Toast's problem, not this system's |

Everything else — schema, views, sync, mapping, verify loop — is identical across tenants and is already tenant-scoped by RLS.

---

## 8. Onboarding runbook for the next restaurant

Written as the sequence that actually worked, with the gates from the definition of done.

**Day 0 — access.** Create tenant + location; the operator generates Toast Standard API credentials for their location and pastes them into `.env.toast`; `pnpm creds` stores them in Vault. Give them the inbound address. Collect a dozen real invoices from their three or four biggest vendors as the fixture corpus (photos are fine).

**Day 0 — sales truth.** `pnpm sync` until caught up (a full-service restaurant is ~500 orders/week; 90 days runs in minutes). `pnpm menu:sync`. Then the gate: three business days of `pnpm pmix` against Toast Web's Product Mix export, item for item. If a day disagrees, the cause is almost always a flattening edge (a modifier with its own GUID, a void at check level) — fix it in `flatten.ts` *with a fixture from that day's payload*.

**Days 1–3 — invoices.** Run the fixture corpus through `pnpm invoices:replay`. For each vendor format that parses badly, add a fixture and expected JSON and adjust the parser prompt or a `vendors.kind` behavior; re-run `pnpm invoices:remap`. Target: ≥ 90 % of lines auto-mapped, every ingredient in the catalog born from a line. Then switch the vendors' billing email.

**Days 3–7 — recipes.** `pnpm recipes:draft --limit 50` for the top sellers; the owner clears the Q&A queue on their phone in a couple of sittings. Gate: the usage page shows "72 margaritas → 108 oz tequila" from live data with all components confirmed.

**Days 7–14 — the loop.** The owner does one real count (`counted`) to set baselines on the top items, then uses the verify screen daily. Gate: a month of invoices posted, verify screen used daily, price comparison shows at least one real savings row.

What this runbook does *not* include: any catalog entry, any pack-size table, any spreadsheet the owner maintains.

---

## 9. Generalizing beyond restaurants

Strip the restaurant nouns and the pattern is: **a sales feed × a recipe (bill of materials) = theoretical consumption; invoices = the catalog, unit costs, and purchases; a verification loop closes the gap.** The parts that are restaurant-specific are small and isolated.

| Component | Restaurant-specific? | Adjacent-vertical change |
|---|---|---|
| Invoice intake, parse, map, post — including portal pull and outbound quote requests | No | Vendor layouts and pack vocabulary only |
| Ingredient catalog born from invoices | No | Category enum |
| Unit normalization (`units.ts`, `packs.ts`) | Partly — volume/mass/each with restaurant pack formats | Add vertical pack formats (rolls, reams, sq ft, linear ft, doses) |
| Sales feed (`lib/toast`, `flatten.ts` → `sales_facts`) | Yes — Toast-shaped | **The one adapter**: any POS that yields (item id, business date, quantity, voided, net) fits `sales_facts` unchanged |
| Item catalog (`menu_items`) | Yes — menus v2 | Same adapter: (item id, name, category, price) |
| Recipes (`recipe_components`) | No — it is a bill of materials | Prompt context per vertical |
| Verification loop, on-hand, variance, price comparison | No | Nothing |

**Where the same build lands with a configuration change and one sales adapter:**

| Vertical | Sales feed | "Recipe" | Notable invoice/pack quirks |
|---|---|---|---|
| Bars, breweries' taprooms | Toast, Square, Clover | Pours per drink; kegs by the ounce | Kegs (1/2, 1/6 bbl), retail liquor receipts, deposit lines |
| Cafés, bakeries | Square, Toast | Grams of flour/butter per SKU; milk per drink size | Weight-sold items, bulk sacks, dairy by the crate |
| Caterers | Quotes/events rather than tickets — the catering engine's own orders are the sales feed | Per-head packages | Same vendors as the restaurant; on-hand matters less, per-event COGS matters more |
| Small grocers, bodegas, farm stands | Square, Shopify POS | Recipe is 1:1 (sell what you buy) — the catalog and price comparison *are* the product | Case/each conversions, UPCs on invoices make mapping nearly deterministic |
| Salons, spas | Booking software (Vagaro, Square Appointments) | Product used per service | Professional-product distributors, ml per application |
| Landscapers, small contractors | Job tickets/invoices out | Materials per job type | Supplier invoices by the bag/yard/board-foot; the price-comparison view is the headline |

The order of work for a new vertical is the same as for a new restaurant, with one extra step at the front: write the sales adapter (`lib/<pos>/client.ts` + a `flatten.ts` with fixtures) to fill `sales_facts` and `menu_items`. Nothing downstream of those two tables knows or cares where they came from.

---

## 10. Security, ops, and what to watch

Secrets: POS client secret in Vault, read only by service-role code through `security definer` RPCs (`set_toast_credentials` for members, `get_toast_client_secret` for the service role only). Env holds the Supabase service key, LLM key(s), `CRON_SECRET`, Resend key and webhook secret. Invoice files are private Storage objects behind short-lived signed URLs. RLS on every tenant table; cron and inbound routes use the service role and check their own secret.

Observability is three tables: `sync_runs` (every POS pull), `inbound_events` (every email delivery), `llm_calls` (every model call with raw output, tokens, cost, provider). Between them you can answer "did we get it, did we read it, what did it cost" without logs.

Known gaps at the reference build (2026-09-06), in priority order: the vendor-portal adapters have not run against a real portal (no credentials yet; the workflow, intake auth and attach path are proven); the restaurant's sending domain is not verified in Resend, so quote requests are held as `blocked_sender` until the DNS records are added; the Product Mix gate has been run against an independent walk of the raw orders and the Toast MCP but not yet against a Toast Web export; salaried staff carry no hourly wage, so labor cost understates payroll; most recipes are unconfirmed drafts, so pour cost on `/position` is far below reality; the deprecated Postmark route should be removed after ten Resend invoices.

---

## 11. State of the reference build (2026-09-06)

Added on 2026-09-06 (`docs/REPORT-3.md`): the Coca-Cola bag-in-box ticket posts with each of its seven syrups on its own fountain item at $0.209/fl oz (320 fl oz per 2.5 gal box, a default the owner can override); the catalog carries origin and health (3 confirmed, 210 pending drafts, 22 dormant, 1 archived) with merge-into and archive on the phone; quote requests are held until `madmoosebarandgrill.com` verifies; the 86-list is polled every five minutes (35 items out of stock or limited at first read) and feeds the verify screen and the daily rows; 876 labor time entries over 78 days sit beside pour cost on `/position` (week of Aug 24: 419 hours, $6,549); the portal-pull workflow runs green end to end on GitHub Actions against production, awaiting real portal credentials.

Live as of 2026-09-05: 6,251 real orders (Jun 7 – Sep 5) → 14,207 `sales_facts` rows, verified item-for-item against an independent walk of the raw orders and the live Toast MCP on three business days; 275 menu items and 417 modifiers; five-minute sync running with zero errors; 727 drafted recipe components on 322 menu items and 222 inventory items (197 created by the recipe drafter); `daily_position` backfilled for 90 days × 236 items and proven equal to `on_hand_estimate`, with restatement demonstrated on a real late invoice; the portal-pull channel, the clean-copy attach, the outbound quote request and the forward price model are built and gated (`docs/REPORT-2.md`); day-of-week net sales reproduce the shape of the operator's independent analysis (Fri > Sat > Thu > Tue > Sun > Mon). Fifteen liquor ingredients exist because they appeared on two cash-register receipts from a state liquor store — each with a real cost per ounce, no one typed a name — and both receipts posted. Five real vendors' documents are in the fixture corpus (Farrell, Restaurant Depot, 802 Spirits, Coca-Cola NE, PFG). Over a hundred fixture tests pass on the pure core.

That is the template: a POS feed, an inbox, a phone, and a rule that the invoice is the root.
