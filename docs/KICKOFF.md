# Claude Code prompts — simple build

Two ways to run this. **Prompt E** builds everything end to end in one session with self-checked gates (paste once, answer its questions when it stops). The **three-step prompts** below it do the same work in checkpoints if you'd rather review between stages. Same setup either way.

## Setup (already done for you)

- This repo exists with `CLAUDE.md`, `docs/`, and `supabase/migrations/` in place.
- Supabase project `xchef-dev` (ref `gqahyzoebifscqcrrkgq`, us-east-1) exists and migrations 0001 (schema) and 0002 (RLS) are **already applied**. Run `npx supabase login && npx supabase link --project-ref gqahyzoebifscqcrrkgq` once, then `npx supabase db pull` to sync local migration history.
- Vercel project is linked to this repo (auto-deploys `main`).

## Setup (you, ~5 minutes)

1. Clone the repo, `pnpm install`.
2. Copy `.env.example` to `.env.local`; fill the Supabase anon + service-role keys (Supabase dashboard → Project Settings → API), an `ANTHROPIC_API_KEY`, and random strings for `CRON_SECRET` and `POSTMARK_INBOUND_SECRET`. Set the same values in Vercel → Project → Environment Variables.
3. Have Mad Moose's Toast client id, client secret, and location GUID handy (Toast Web → Integrations → Toast API access). Don't paste them into the chat; Claude Code will give you a command.
4. Put 5–10 real invoices (PDF or phone photo) into `fixtures/invoices/`. Three from different vendors is enough to start.

Then open one Claude Code terminal in the repo.

---

## Prompt E — end to end, one session

```
Read CLAUDE.md, AGENTS.md, and docs/architecture.md §4 (all subsections) before writing any code. This repo is on Next.js 16; follow AGENTS.md conventions, not older habits. If a Toast MCP server is available to you, use it to inspect real payloads while you work; the app itself must call Toast over HTTPS via lib/toast.

Build the whole app described in CLAUDE.md, in this order, stopping ONLY at the two gates marked STOP. Do not ask questions you can answer by choosing the simplest option and noting it in a commit message.

PHASE 1 — sales truth
- The schema (supabase/migrations/0001_init.sql) and RLS (0002_rls.sql) are ALREADY APPLIED to the linked Supabase project. Do not re-apply. Run `supabase db pull` to sync, then generate lib/db/types.ts.
- lib/db: browser, server (user cookie), and service-role clients.
- Auth (Supabase magic link) + first-login bootstrap (tenant "Mad Moose", one location, my membership — inserted with the service-role client since RLS blocks a user with no membership) + Settings (timezone, Toast location GUID, Toast client id/secret stored to Supabase Vault via server action; secret never returned). Also `pnpm creds` CLI that prompts for the three values and stores them.
- lib/toast: login with token cache (expiresIn−60s), Toast-Restaurant-External-ID header, ordersBulk async iterator (pageSize 100, follow Link header, 4 req/s), menus v2 (menus, metadata), config lookups. Zod at the boundary; quarantine invalid orders.
- lib/core/flatten.ts per CLAUDE.md rule 3, with a synthetic fixture test (order/check/selection voids, modifier with own item.guid, decimal-quantity weight item, tab opened 11:50pm closed 1:10am → earlier businessDate).
- lib/jobs/toastSync.ts + app/api/cron/toast-sync (CRON_SECRET, vercel.json every 5 min): window last_synced_at−36h→now (first run 90 days back in 7-day chunks), upsert toast_orders_raw, rebuild sales_facts for touched business dates in one transaction, update last_synced_at, log to a sync_runs table (migration 0003, also appended to docs/schema.sql). `pnpm sync` runs it locally.
- `pnpm pmix --date YYYY-MM-DD` prints SUM(quantity_sold) per item name.
STOP 1: tell me the creds command, the sync command, and the pmix command. Wait for me to confirm three business days match Toast's Product Mix report. If I paste mismatches, fix flatten.ts and its fixtures, then re-run.

PHASE 2 — recipes and usage
- lib/jobs/menuSync.ts + app/api/cron/menu-sync (daily) + "sync now" in Settings: pull /menus/v2/menus when metadata lastUpdated changes; upsert menu_items; modifier options as their own rows.
- lib/llm/recipe-draft.ts (Sonnet, tool-use, temp 0, pinned model, raw output stored) + a "Draft recipes" action that runs it in batches with progress for every item without components.
- Inventory catalog page (inventory_items CRUD).
- Recipe Q&A page: one card at a time, ordered by units sold last 30d × (1 − max confidence); Accept / Edit / Skip; Accept or Edit → confirmed; flip recipe_status when complete. Phone-first: 30 cards in five minutes, one thumb.
- Usage page (usage_by_menu_item, usage_by_period, last 7 days default, usage_cost when known, unconfirmed badged) and Plate cost table (menu_item_cost, worst margin first).
Continue without stopping.

PHASE 3 — invoices, verification, prices
- lib/core/packs.ts (parsePackSize with defaults table; #10 returns a range flag; parsed > default; tests for "6/#10", "3/114OZ", "12/750ML", "4/1GAL", "40 LB", "CS", "2/5LB", "24/12OZ", "1/6 BBL", "50 LB BAG").
- lib/llm/invoice-parse.ts (Sonnet, PDF/image input, schema from architecture.md §4.3) with one fixture test per file in fixtures/invoices (files gitignored, expected JSON committed). If fixtures/invoices is empty, generate three realistic synthetic invoices as PDFs (Sysco-style, produce, liquor) and use those, clearly labeled synthetic.
- lib/llm/sku-match.ts (Haiku over the full inventory list → existing | new item | not_inventory + pack + confidence) and lib/core/resolveMapping.ts (sku → description → sku-match; auto-map ≥ 0.92 when the item exists; compute quantity_base_unit, cost_per_base_unit). Tests with the ketchup two-vendor and tomato price-doubling cases from docs.
- Intake: app/api/intake/upload (multipart; image/pdf/HEIC; client resizes photos ≤ 2000px), /paste, /manual, and app/api/inbound/postmark (path secret, dedupe content_hash + email_message_id, Fwd: detection with original sender, vendor guess from email_domains, Storage path invoices/<location>/<yyyy>/<mm>/<hash>.<ext>, 200 fast). Each creates invoice_documents then runs parse → map inline; post when all lines resolved; price-refresh updates inventory_items.cost_per_base_unit.
- Invoices page (list; big camera button as the primary action on mobile; upload/paste/manual) and Review page (image via signed URL, unresolved lines expanded, confirm writes vendor_item_mappings with pack_description and brand and re-runs mapping; "not an invoice" → rejected).
- Verify page = app home: verification_queue top 10; row shows item, "you should have ~11.4 bottles" (on_hand_packs), reason, value_per_pack; ✓ (confirmed_estimate + estimate_at_count) or number in pack units (counted); position from local time (before 2pm → open), toggleable; after save show new on-hand and, for counted rows, variance in $ and packs inline. Server-rendered, < 1s on 4G.
- On-hand page (by category, days of supply, "verify to set a baseline") and Prices page (vendor_switch_savings "You're overpaying for…" by annual savings with assumed base units per pack shown; unit_cogs_master with 30-day change).
- PWA: manifest, icons, service worker with app-shell caching, standalone display, installable on iOS Safari and Android Chrome. Bottom tab bar: Verify · Invoices · Usage · Prices · More.
- `pnpm seed:demo` (tequila/ketchup/tomato from docs) so every page renders before real data.
STOP 2: run pnpm test && pnpm typecheck && pnpm build, push to main (Vercel auto-deploys), and give me: the deployment URL, the five-line Postmark inbound setup (domain, MX, webhook URL), the env vars I still need to set in Vercel, and a one-paragraph summary of any choice you made that deviates from CLAUDE.md.
```

---

## Three-step alternative

### Step 1 — Sales truth

```
Read CLAUDE.md fully, then docs/architecture.md §4.1 (Toast sync and flattening rules). Build Step 1 only.

1. The schema and RLS are already applied to the linked Supabase project (migrations 0001, 0002). Run `supabase db pull` to sync, then generate types into lib/db/types.ts. Add lib/db with three clients: browser (anon), server (anon + user cookie), service (service role, server-only).
2. Auth: Supabase magic-link login, and a one-time bootstrap that creates one tenant ("Mad Moose"), one location, and my membership on first login (service-role insert — RLS blocks a user with no membership yet). Settings page with the location's timezone, Toast location GUID, and a form that stores the Toast client id/secret into Supabase Vault via a server action (secret never returned to the browser). Also give me a CLI alternative: `pnpm creds` that prompts for the three values and stores them, so I don't need the UI to be pretty.
3. lib/toast: login (POST /authentication/v1/authentication/login, userAccessType TOAST_MACHINE_CLIENT) with an in-memory token cache expiring at expiresIn−60s; Toast-Restaurant-External-ID header on every call; an async iterator over /orders/v1/ordersBulk?startDate&endDate&pageSize=100 following the Link header, throttled to 4 req/s; plus menus v2 (menus, metadata) and config lookups. Zod-validate; quarantine (log + skip) orders that fail validation.
4. lib/core/flatten.ts: pure function Order[] → sales_facts rows per CLAUDE.md rule 3. Tests: I'll add real ordersBulk pages to fixtures/toast/ once the sync runs; for now write a synthetic fixture that covers order/check/selection voids, a modifier with its own item.guid, a decimal-quantity weight item, and a tab opened 11:50pm / closed 1:10am (businessDate = earlier day).
5. lib/jobs/toastSync.ts and app/api/cron/toast-sync/route.ts (protected by CRON_SECRET, vercel.json cron every 5 minutes): window = last_synced_at − 36h → now (first run: 90 days back in 7-day chunks, run sequentially until caught up), upsert toast_orders_raw, rebuild sales_facts for touched business dates in one transaction, update last_synced_at, write a row to a new sync_runs table (add it as migration 0003 and append to docs/schema.sql). Also a `pnpm sync` script that runs the same function locally so I don't need Vercel to test.
6. `pnpm pmix --date YYYY-MM-DD`: prints SUM(quantity_sold) per item name for that business date so I can compare with Toast's Product Mix report.

When done, tell me exactly: the command to store credentials, the command to run the first sync, and the command to print a day for comparison. Do not build anything from Step 2 yet.
```

Then you: run the creds command, run `pnpm sync`, pick three recent business days, run `pnpm pmix` for each, and compare against Toast Web → Reports → Product Mix. If items match, paste Step 2. If not, paste the mismatches into the terminal and let it fix the flattening.

---

### Step 2 — Recipes and usage

```
Step 1 is validated: three days match Product Mix. Read docs/architecture.md §4.2. Build Step 2.

1. lib/jobs/menuSync.ts + app/api/cron/menu-sync (daily, plus a "sync now" button in settings): pull /menus/v2/menus when /menus/v2/metadata lastUpdated changes; upsert menu_items (GUID, name, price, category from sales category), and modifier options as their own menu_items rows so they can carry recipes.
2. lib/llm/recipe-draft.ts: Sonnet tool-use call taking one menu item (name, category, price, modifier names) plus the tenant's full inventory_items list, returning components (existing item or new-item proposal, quantity, unit, confidence). Temperature 0, pinned model, zod-validated, raw output stored on the recipe_components rows' menu item. A "Draft recipes" button on the menu page that runs it for every item without components, in batches, with progress.
3. Inventory catalog page: inventory_items CRUD (name, category, base_unit, pack_to_base_factor, cost_per_base_unit optional).
4. Recipe Q&A page: one card at a time, ordered by units sold last 30 days × (1 − max confidence). Each card asks one question with the AI guess prefilled in the ingredient's base unit; Accept / Edit / Skip. Accept or Edit → source='confirmed', confirmed_at; flip menu_items.recipe_status when all components are confirmed. Mobile-first — I should clear 30 cards in five minutes on my phone.
5. Usage page: usage_by_menu_item and usage_by_period for a date range (default: last 7 days), with usage_cost when costs exist; unconfirmed recipes badged, not hidden. Plate cost table from menu_item_cost sorted worst margin first.

Everything reads the SQL views; no math in React. When done, tell me how to run the first recipe draft.
```

---

### Step 3 — Invoices, verification, prices

```
Step 2 is live. Read docs/architecture.md §4.3 and §4.4 in full. Build Step 3.

1. lib/core/packs.ts: parsePackSize(text, baseUnit) → {units_per_pack, base_units_per_unit, source:'parsed'|'default', assumed_text}. Handle "6/#10", "3/114OZ", "12/750ML", "4/1GAL", "40 LB", "CS", "2/5LB", "24/12OZ", "1/6 BBL", "50 LB BAG". Defaults table for cans, bottles, kegs; #10 cans vary by product (roughly 102–128 oz) so return a range flag rather than pretending. Unit tests.
2. lib/llm/invoice-parse.ts: Sonnet with the PDF/image and the schema in architecture.md §4.3 (is_invoice, document_kind, vendor, invoice number/date, totals, lines with sku/description/pack_size_text/quantity/unit_price/extended_price/category_guess/confidence). One fixture test per file in fixtures/invoices asserting vendor, line count, Σ extended ≈ subtotal ±2%. Never commit the invoice files, only the expected JSON.
3. lib/llm/sku-match.ts: Haiku, given one invoice line and the full inventory_items list, returns {choice: existing item id | new item {name, category, base_unit} | not_inventory, pack: units_per_pack & base_units_per_unit, confidence}. lib/core/resolveMapping.ts: exact (vendor, sku) mapping → normalized description mapping → sku-match; auto-map at ≥ 0.92 when the item exists, else needs review. Compute quantity_base_unit and cost_per_base_unit. Unit tests with the ketchup (two vendors, two pack formats) and tomato (price doubled) examples from docs.
4. Intake routes: app/api/intake/upload (multipart, PDF/JPG/PNG/HEIC), /paste (text), /manual (vendor, date, lines → skips parsing), and app/api/inbound/postmark (path secret, dedupe on content_hash + email_message_id, detect Fwd: and recover original sender, guess vendor from vendors.email_domains, store to Storage invoices/<location>/<yyyy>/<mm>/<hash>.<ext>, 200 fast). Each creates invoice_documents and then runs parse → map inline; post when all lines resolved; price-refresh updates inventory_items.cost_per_base_unit from the latest posted line.
5. Invoices page (list + upload/paste/manual) and Review page: document image via signed URL on the left, lines on the right, only unresolved lines expanded; confirming writes vendor_item_mappings (with pack_description and brand) and re-runs mapping for the document; "not an invoice" → rejected. `pnpm invoices:replay` runs the whole pipeline over fixtures/invoices locally.
6. Verify page — make this the app's home: verification_queue top 10 per visit. Row = item, "you should have ~11.4 bottles" (on_hand_packs, base-unit fallback), reason, value_per_pack; actions ✓ (stock_counts verification='confirmed_estimate', estimate_at_count) or a number in pack units (verification='counted'); position defaults from local time, toggleable; after save show the new on-hand and, for counted rows, variance in $ and packs inline.
7. On-hand page (on_hand_estimate by category, days of supply, "verify to set a baseline" for has_baseline=false) and Prices page (vendor_switch_savings as "You're overpaying for…" sorted by annual savings with assumed base units per pack on every row; unit_cogs_master with 30-day price change).
8. PWA: manifest, icons, service worker, standalone display; bottom tab bar Verify · Invoices · Usage · Prices · More.

Seed a demo dataset (tequila/ketchup/tomato from docs) behind `pnpm seed:demo` so every page renders before real invoices exist. When done, tell me the Postmark inbound setup steps (domain, MX, webhook URL) in five lines or less.
```

---

## After Step 3

Use it daily at Mad Moose for a month before adding anything. Then the candidates, in order of value: the 7 a.m. email digest (top of verification_queue + invoices needing review + top savings), Stripe + self-serve onboarding for a second restaurant, and only then the worker/queue split from architecture.md if the cron routes start timing out.
