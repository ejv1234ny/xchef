# CLAUDE.md — xchef (working name)

Restaurant usage & inventory app that sits beside Toast POS. Toast Orders API (read-only) → theoretical ingredient usage; AI-parsed vendor invoices → purchases and unit costs; a verification checklist the owner taps to reset on-hand. First and only user for now: Mad Moose Bar & Grill (Waitsfield, VT), one location, Toast Standard API access.

**This is the simple build.** One Next.js app, one Supabase project, no worker, no queue, no monorepo. Multi-tenant SaaS hardening comes later; the schema already supports it, the app does not need to yet.

**It is a phone app first.** Everyone in a restaurant has a phone; almost nobody is at a desk. Every screen is designed at 390px wide before anything else, installable as a PWA (manifest, icons, service worker, standalone display), with the camera as the primary invoice intake and one-thumb actions on the verify screen. Desktop is the same layout, wider. Also read `AGENTS.md` — this repo is on Next.js 16 and its conventions differ from older training data.

## Source of truth

- `docs/schema.sql` — the entire data layer, already validated on Postgres 16 and **already applied to Supabase project `xchef-dev` (ref gqahyzoebifscqcrrkgq) along with RLS (migration 0002)**. Do not re-apply; run `supabase db pull` once to sync the local migration history, then add new migrations only. **All money and quantity math lives in its views** (`usage_by_period`, `usage_by_menu_item`, `menu_item_cost`, `purchases_by_item`, `unit_cogs_master`, `vendor_price_comparison`, `vendor_switch_savings`, `on_hand_estimate`, `count_variance`, `verification_queue`). App code reads views; it never recomputes them.
- `docs/architecture.md` — the full-scale design. Use it for *how each piece should behave* (sync window, flattening rules, invoice states, verification semantics). Ignore its infrastructure choices (Turborepo, Railway worker, pg-boss, pgvector, four workstreams) — the section below replaces them.
- `docs/data-model.md` — why each table exists.

## Stack (simple)

- Next.js 16 App Router, TypeScript strict, Tailwind + shadcn/ui, deployed on Vercel (Pro, for cron and 300s functions).
- Supabase: Postgres, Auth (magic link), Storage bucket `invoices` (private), Vault for the Toast client secret.
- LLM: **OpenAI (default) or Claude, behind `lib/llm/provider.ts`** (`LLM_PROVIDER=openai|anthropic`). OpenAI: Responses API with strict JSON-schema structured output (zod → strict schema in `lib/llm/strict-schema.ts`), gpt-4.1 for invoice parsing (PDF/image input) and recipe drafting, gpt-4.1-mini for SKU and sheet mapping. Claude: Sonnet / Haiku via forced tool use. Temperature 0, model ids pinned in `lib/llm/models.ts`, raw output + tokens + cost + provider stored in `llm_calls`.
- Scheduling: Vercel Cron hitting route handlers (`/api/cron/toast-sync` every 5 min, `/api/cron/menu-sync` daily, `/api/cron/daily-position` daily at 09:00 UTC, `/api/cron/quote-requests` Mondays 13:00 UTC). Each run is short and idempotent, so no queue. The vendor-portal pull needs a browser, so it runs in GitHub Actions (`.github/workflows/portal-pull.yml`, daily 11:00 UTC) and posts files to `/api/intake/upload` with the `x-intake-key` header.
- Invoice parsing runs inline in the upload / inbound route (one document per request, well under the function limit).
- Inbound email: **Resend** → `/api/inbound/resend` (webhook event `email.received`, Svix-signed with `RESEND_WEBHOOK_SECRET`, 401 on a bad signature, 200 fast, work in `after()`). Attachments are fetched through Resend's API (`RESEND_API_KEY`) and handed to the same intake → parse → map → post pipeline; every delivery is logged in `inbound_events`. The address vendors and Mad Moose forward to is `INBOUND_EMAIL_ADDRESS` — on Resend's default receiving domain (`…@<id>.resend.app`) now, a custom domain via an MX record later; any local part maps to the single location today (later local part = `locations.inbound_email_slug`). The Postmark route (`/api/inbound/postmark/[secret]`) is deprecated and is removed once Resend has processed 10 real invoices. Photos and scans come through the app's upload page, so webhook payloads stay small.
- SKU → ingredient matching: no vector DB. A restaurant has a few hundred inventory items; pass the whole list to Haiku with the invoice line and let it choose, propose new, or mark not-inventory.
- Tests: Vitest for `lib/core/*` only, from fixtures.

## Layout

```
app/
  (app)/verify  on-hand  usage  prices  invoices  invoices/review  recipes  menu  settings  position
  api/cron/{toast-sync,menu-sync,daily-position,quote-requests}  api/inbound/{resend,postmark/[secret]}  api/intake/{upload,paste,manual}
lib/
  toast/      client: login + token cache, ordersBulk pager, menus v2, config
  core/       PURE: flatten.ts, units.ts, packs.ts, resolveMapping.ts, sheets.ts, liquor.ts, position.ts, quotes.ts  (tests live here)
  llm/        invoice-parse.ts, recipe-draft.ts, sku-match.ts  (schemas + prompts)
  db/         supabase clients (browser, server, service-role), typed helpers, generated types
  jobs/       toastSync.ts, menuSync.ts, intake.ts, parseInvoice.ts, parseSpreadsheet.ts, mapInvoice.ts, postInvoice.ts, recipeDraft.ts, dailyPosition.ts, quoteRequest.ts, quoteIngest.ts  (called by routes and scripts)
  portals/    one Playwright adapter per vendor portal (pfg.ts, sysco.ts) used only by scripts/portal-pull.ts in GitHub Actions
  inbound/    Resend webhook processing (resend.ts, shared.ts)
scripts/     pnpm creds | sync | pmix | menu:sync | recipes:draft | invoices:replay | invoices:reparse | invoices:remap | position | validate:position | portal:pull | quotes:request
supabase/migrations/20260904002855_init.sql   ← docs/schema.sql (ALREADY APPLIED to xchef-dev)
supabase/migrations/20260904002929_rls.sql    ← RLS policies + security_invoker views (ALREADY APPLIED)
.mcp.json + scripts/toast-mcp.sh    ← community Toast MCP for dev-time payload inspection
fixtures/    toast/*.json (real ordersBulk pages), invoices/*.pdf|jpg (gitignored) + expected *.json
```

## Rules that still matter at this size

1. Sales from `GET /orders/v2/ordersBulk` only — not the Analytics API. Menus from `/menus/v2`. Scopes `orders:read menus:read config:read restaurants:read`; never guest PII scopes.
2. Use Toast `businessDate`. Sync window `last_synced_at − 36h → now`, upsert `toast_orders_raw`, rebuild `sales_facts` for touched business dates in one transaction. ≤ 4 req/s.
3. `lib/core/flatten.ts`: skip deleted orders/checks; voided → `quantity_voided`; modifiers with their own `item.guid` get their own rows; refunds not subtracted; keep decimal quantities.
4. Never hardcode a pack size. `lib/core/packs.ts` holds defaults; a size parsed from the invoice overrides it; the owner's edit on `vendor_item_mappings` overrides both; the UI shows the assumed base units per pack on every price row.
5. Store everything in the ingredient's `base_unit` (numeric 14,4). Pack units are display/count only.
6. On-hand = last verified count + purchases since − usage since. ✓ tap = `verification='confirmed_estimate'` with `estimate_at_count`; typed number = `'counted'`; `position` open/close from local time (before 2 pm → open), user can flip. Only `counted` rows feed variance charts and calibration.
7. Verify screen order = `verification_queue.priority_score` (dollar burn × staleness × price shock). Variance shown in $ and packs.
8. Every intake path (email, forward, upload, paste, manual, api) creates an `invoice_documents` row and goes through parse → map → post. Post only when every line is mapped or ignored. Statements → rejected. Credits → negative quantities. A page can hold several receipts: the parser returns `documents[]` and each becomes its own `invoice_documents` row on the same file; discounts/promos under an item are that line's `adjustment`, never lines; every document is validated (Σ lines = printed subtotal, line count or quantity = printed count) with one model retry, and deduped per receipt on `(vendor_id, receipt_id)` (barcode/receipt number; register codes go in `transaction_code`) or `(vendor, date, time, total)`. Retail liquor vendors (`vendors.kind = 'retail_liquor'`) count bottles: size from the item name, else 750 ml assumed and fixable in one tap. Spreadsheets (`.csv .tsv .xlsx .xls`, ≤ 5 MB) are a first-class format everywhere a PDF or photo is accepted: `lib/jobs/parseSpreadsheet.ts` replaces the LLM parse step — known layouts in `lib/core/sheets.ts` map deterministically, unknown headers are mapped once by Haiku (or the header heuristic) and remembered in `vendor_sheet_layouts` by header fingerprint, one `invoice_documents` row per (invoice_number, invoice_date) group, lines written straight to `invoice_lines`, then the same map → post.
9. Inbound webhook returns 200 fast, never bounces, dedupes on `content_hash` and `email_message_id`.
10. Zod at every boundary (Toast payloads, LLM output, webhooks). Quarantine and log failures; never crash a cron run.
11. Money and quantities are `numeric` in Postgres and strings/Decimal in TS until display. No float math.
12. Fixture tests for `flatten.ts`, `packs.ts`, `resolveMapping.ts` from real Mad Moose data. A change there without a fixture test is not done.
13. Secrets: Toast client secret in Supabase Vault (read only by the service-role server code). Env: `SUPABASE_SERVICE_ROLE_KEY`, `LLM_PROVIDER` + `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` + `ANTHROPIC_WORKSPACE_ID` for identity-linked keys when `LLM_PROVIDER=anthropic`), `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `INBOUND_EMAIL_ADDRESS` (display only; also the reply-to of quote requests), `QUOTE_FROM_EMAIL` (verified Resend sender for outbound quote requests), `INTAKE_API_KEY` (the `x-intake-key` the portal pull presents; also the GitHub secret `XCHEF_INTAKE_KEY`), and `POSTMARK_INBOUND_SECRET` until the Postmark route is removed. Vendor-portal logins (`PORTAL_PFG_USER/PASS`, `PORTAL_SYSCO_USER/PASS`) live only in GitHub Actions secrets, never in Vercel. Never print a secret value into a report, commit, log line, or chat.
14. RLS on with the pattern in schema.sql, one tenant, one membership. Cron and inbound routes use the service-role client and check `CRON_SECRET` / the path secret.
15. Mobile: 44px minimum tap targets; no hover-only affordances; `<input type="file" accept="image/*,application/pdf" capture="environment">` for invoice photos, client-side resize to ≤ 2000px before upload; HEIC accepted; verify and review screens must work one-handed; Lighthouse PWA installable on iOS Safari and Android Chrome; the verify page loads its top-10 list in < 1 s on 4G (server-render it).
16. **Daily reconciliation.** `daily_position` is one row per (location, ingredient, business date): opening, received, theoretical use, expected close, count, variance in units and dollars, plus `restated_at`/`restatement_reason` when a late invoice, sales rebuild, backdated count or recipe change moves a day that was already computed. It is computed by `lib/jobs/dailyPosition.ts` (cron 09:00 UTC, `pnpm position`) from the views, never by hand; `scripts/validate-position.ts` proves yesterday's expected close equals `on_hand_estimate`. Restated rows are re-written, never deleted — the discrepancy is the product.
17. **Quotes are not purchases.** A vendor's reply to a quote request (`[Q-token]` in the subject, sent by `lib/jobs/quoteRequest.ts` from `QUOTE_FROM_EMAIL` with the inbound address as reply-to) is parsed by the same parser with `document_kind = 'quote'`, mapped through the same vendor mappings, and written to `vendor_quotes`. `purchases_by_item`, `item_price_history` and on-hand exclude quote documents; `forward_price_model` picks the valid quote over the last invoice (`basis = quote|invoice`) and `vendor_price_comparison` / `vendor_switch_savings` rank on that expected next cost.
18. **The portal copy attaches, it does not duplicate.** A document arriving with `source = 'api'` and the same `(vendor, invoice_number)` as a paper/photo document becomes that document's `clean_storage_path`; totals matching within a cent set `verified_by_clean_copy_at`, otherwise `parse_diff` ("paper said / portal says") sends it back to review. Where a portal offers "email me my invoices", prefer that over the browser job.
19. A Toast MCP server is configured in `.mcp.json` (`scripts/toast-mcp.sh` → community read-only server, demo mode until `.env.toast` exists). Use its `toast_find_orders`, `toast_get_order`, `toast_search_menu` tools during development to inspect real payloads and cross-check `pmix` output. It is unofficial and "live-unverified" — treat its output as a convenience, not truth; the app itself always talks to Toast through `lib/toast` over HTTPS (`/orders/v2/ordersBulk`, `/menus/v2/menus`), never through MCP.

## Definition of done

- **Step 1 — Sales truth:** three business days where `sales_facts` matches Toast Web's Product Mix report per item. Nothing else until this passes.
- **Step 2 — Headline:** recipe Q&A cleared for the top 50 items by sales; usage page shows "72 margaritas → 108 oz tequila" from live data.
- **Step 3 — Inventory:** a month of invoices posted with most lines auto-mapped, verify screen used daily, price comparison shows at least one real savings row.

## Conventions

Small commits on `main` (one developer). `pnpm test && pnpm typecheck` before each commit. UI copy for an owner on a phone in a walk-in: pack units, dollars, one tap. Ask one question at a time and only when blocked; otherwise choose the simplest thing and note it in the commit message.
