# Data Model — Usage Tracking

The whole schema exists to answer one question per period:

> "Based on **72 margaritas** sold, you used **108 oz tequila, 36 oz simple syrup, 14 lb limes**…"

That number is just `sales × recipe`. Everything else supports computing, confirming, or refining it.

Receiving is **automated, not manual**: vendors email invoices to a per-location inbox, an LLM parses them, and learned SKU mappings post them as purchases. With purchases flowing in, the second headline becomes possible:

> "You have **~14 bottles of tequila** on hand; at this pace you'll reorder Thursday."

`on_hand = last count + purchases since − usage since`. Counts are occasional and optional; each one also yields a variance (shrink / over-pour) signal.

## The three things and the join

| Concept | Table | Where it comes from |
|---|---|---|
| What sold | `sales_facts` | Toast **Orders API** (`GET /orders/v2/ordersBulk`), flattened Order → Check → Selection, rolled up per item per business day |
| What it's made of | `recipe_components` | AI draft from menu upload → confirmed in the Q&A |
| The raw ingredient | `inventory_items` | created as recipes are built (catalog of "things used") |
| Menu item | `menu_items` | parsed from menu upload, matched to Toast GUID (Menus v2 API) |
| What was bought | `invoice_documents` / `invoice_lines` | inbound email → LLM parse → `vendor_item_mappings` |
| What's actually there | `stock_counts` | occasional physical count (optional) |

Usage = for each menu item, `quantity_sold × recipe quantity`, summed per ingredient. That's the `usage_by_period` and `usage_by_menu_item` views — no extra computation layer needed.

## How the product flow maps to columns

**Menu upload → ingredients.** LLM vision parses the menu into `menu_items`. For each, it drafts a probable recipe: rows in `recipe_components` with `source = 'ai_draft'` and a `confidence` score, creating any new `inventory_items` it needs.

**Guided Q&A.** The UI works the queue of low-confidence / unconfirmed components, weighted by sales volume so high-traffic items get confirmed first. When the operator answers ("1.5 oz pour"), the row flips to `source = 'confirmed'`, `confirmed_at` is set, and the parent `menu_items.recipe_status` moves `draft → confirmed`.

**Extrapolation.** Two senses, both supported:
- *Forward* (the headline): once a recipe is confirmed, sales drive usage automatically — the views do it.
- *Reverse* (calibration): between any two counts, `count_variance` gives purchases and theoretical usage; the actual draw ÷ units sold backs out a real pour size (72 margaritas against a 108 oz draw implies 1.5 oz/drink) to propose as a `reverse_engineered` component for the human to confirm.

## Invoice ingestion (receiving with no data entry)

1. **Inbound email.** Each location has `inbound_email_slug` → `invoices-<slug>@<domain>`. The operator gives that address to vendors as the billing email (or forwards to it). An inbound-parse provider (Postmark / Mailgun / Resend / Cloudflare Email Workers) POSTs message + attachments to a webhook, which stores the file in Supabase Storage and inserts an `invoice_documents` row (`status = received`). `content_hash` and `email_message_id` dedupe re-sends. `vendors.email_domains` auto-attributes the sender.
2. **Parse.** A worker sends the PDF/image to the LLM with a structured-output schema (vendor, invoice number/date, line items with SKU, description, pack size, qty, unit/extended price, category guess, confidence). Full output is kept in `raw_extraction`; lines land in `invoice_lines`. Non-invoices (statements, marketing) → `rejected`.
3. **Map.** Each line is matched to `vendor_item_mappings` by `(vendor, vendor_sku)` or normalized description. Hit → `auto_mapped`, and `quantity_base_unit = quantity × units_per_pack × base_units_per_unit` (2 cases × 6 × 25.36 oz). Miss → `unmapped` and the AI proposes an `inventory_items` match (or a new item) for the operator to confirm — same Q&A pattern as recipes, and it only happens the first time a SKU appears. Fees/deposits → `ignored`.
4. **Post.** When every line is mapped or ignored the document becomes `posted`; only then do its lines count in `purchases_by_item`. `cost_per_base_unit` on each line (extended ÷ base qty) is the live price feed for COGS.

## On-hand and variance

`on_hand_estimate` (per location × ingredient): latest `stock_counts` row as baseline, plus `purchases_by_item` after that date, minus `usage_by_period` after that date. Never counted → `has_baseline = false` and the number reads as net change. `count_variance` compares consecutive counts: `prev + purchased − theoretical_used − actual`; positive means unexplained depletion (over-pour, unrung comps, theft).

Toast's Stock API is *not* used — it tracks 86'd menu items, not ingredients.

## Units

Recipes are normally authored in each ingredient's `base_unit` (oz for tequila, lb for limes), so usage needs no conversion. When a recipe line uses a different physical unit, `convert_factor()` handles volume↔volume and mass↔mass automatically. Pack units (case/bottle) are item-specific and use `inventory_items.pack_to_base_factor`.

## Multi-tenancy & Toast credentials

One management group = one `tenant`, with one or more `locations`. Toast **Standard API access** (RMS Essentials tier; ~$50/mo standalone) is **read-only and location-specific** with 13 `*:read` scopes; we need `orders:read`, `menus:read`, `config:read`, `restaurants:read`. Each location stores its own credential set in `toast_credentials` (customer self-generates in Toast Web → Integrations → Toast API access; no partner approval needed). Sync jobs loop per location, sending `Toast-Restaurant-External-ID`. The Analytics API (`/era`) is a separate credential on RMS Pro and is **not** used. Row-level security isolates every tenant via the `memberships` table; see `supabase/migrations/20260904002929_rls.sql`.

## Cost optionality

`inventory_items.cost_per_base_unit` is optional to start; once invoices flow, it should be refreshed from the latest posted `invoice_lines.cost_per_base_unit` so `usage_cost` and `on_hand_value` reflect real prices.
