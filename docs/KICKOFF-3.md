# KICKOFF-3 — Make the discrepancy trustworthy: portals live, parses fixed, catalog pruned, 86-list and labor

Paste everything below the line into Claude Code in `xchef/`. Autonomous: no questions, simplest correct thing, note choices in commit messages, report at the end.

---

You are in `C:\Users\ejv12\Documents\Claude\Projects\Toast Xtrachef Clone\xchef` (Windows, cmd.exe syntax only). `git pull` first. Read `CLAUDE.md`, `docs/BLUEPRINT.md`, and `docs/REPORT-2.md` — REPORT-2 is what the last session built and its §8 assumptions are your starting list. Same rules as always: `pnpm test && pnpm typecheck && pnpm lint` before every commit, small commits on `main`, migrations timestamped and mirrored into `docs/schema.sql` then `pnpm db:types`, pure math in `lib/core/` with fixture tests, no floats, never print a secret. Do not touch `lib/toast/client.ts` auth or `flatten.ts` semantics.

**Use the MCP servers that are configured; do not re-implement what they already do.**
- `toast` (`.mcp.json`, live mode because `.env.toast` exists): `toast_find_orders`, `toast_get_order`, `toast_search_menu` to inspect real payloads before writing any parser or adapter logic.
- `supabase`: `list_tables` before schema changes, `execute_sql` to verify every gate against the live database, `apply_migration` for DDL, `get_advisors` after migrations, `get_logs` when a cron misbehaves.
- `vercel`: `list_deployments` / `get_deployment` to confirm READY after each push, `get_runtime_logs` to read cron output — do not guess whether a deploy worked.
- `github`: only for reading; commits go through git. Secrets are set with `gh secret set NAME` (the `gh` CLI is authenticated), never pasted into files.
- `playwright` if it is configured (`claude mcp list`): use it to drive the vendor portals interactively while fixing selectors. If it is not configured, `npx playwright codegen <portal url>` and the headless runner with screenshots are the fallback.

Six items, in this order. Each one is a commit with its gate verified before the next starts.

## 1. Portal pull — from "written blind" to running daily

Credentials: `.env.portals` in the repo root (gitignored via `.env*`) with `PORTAL_PFG_USER`, `PORTAL_PFG_PASS`, `PORTAL_SYSCO_USER`, `PORTAL_SYSCO_PASS`. If the file is absent, do everything else in this kickoff first, then write the exact `.env.portals` template into the report and stop on this item.

For each adapter in `lib/portals/`: run it headed or via the Playwright MCP against the real portal, fix selectors until it lists the last 14 days of invoices and downloads each as PDF (or CSV where the portal exports one — prefer the export), then run `pnpm portal:pull --dry` to confirm the files reach the intake dedupe path and attach to the existing photographed documents by `(vendor, invoice_number)`. Handle 2FA and "remember this device" once, explicitly: if a portal requires an interactive code, capture the session storage state to `portal-state/<vendor>.json` (gitignored), reuse it in the workflow via a base64 GitHub secret `PORTAL_<VENDOR>_STATE`, and document the re-auth procedure. Set the GitHub secrets (`XCHEF_BASE_URL`, `XCHEF_INTAKE_KEY`, the portal logins, any state blobs) with `gh secret set`, trigger `portal-pull.yml` with `gh workflow run`, and watch it with `gh run watch`.

**Gate 1.** A `workflow_dispatch` run is green against at least one real portal; `invoice_documents` shows ≥ 1 document with `clean_storage_path` set by `source = 'api'` and `verified_by_clean_copy_at` not null (or a `parse_diff` in review, which also counts). Verify with `execute_sql`, not by reading logs.

## 2. Coca-Cola bag-in-box tickets — vendor-specific parse

The Coke NE delivery ticket parses its category headers ("2.5 GALLO 1-Ls JUICE DRI", "…SPARKLING", "…TEA") as line descriptions, so six distinct products collapsed into one "Juice Drink" item and a CO2 line is unmapped. Open the fixture (`fixtures/invoices/`, the Coca-Cola file) and the stored `raw_extraction`; use the Toast MCP `toast_search_menu` to see what fountain products the menu actually sells (Coke, Diet Coke, Sprite, ginger ale, lemonade, iced tea…) so the parser knows the vocabulary. Add `vendors.kind = 'beverage_distributor'` behavior: product identity comes from the product code / flavor column, not the category header; a 2.5 gal BIB is 320 fl oz (9.46 L) — put it in `DEFAULT_PACKS` as a default, overridable as always; CO2 cylinders are `ignored` as non-inventory unless the tenant tracks gas. Split the merged "Juice Drink" item into the real products (write the migration as data fixes with the old item's lines re-pointed; do not delete history), re-run `pnpm invoices:remap --doc <id>`, and add the ticket as a fixture with expected JSON.

**Gate 2.** The Coke document posts with every line mapped to a distinct real product, cost per fl oz within 5 % of extended ÷ 320 per box; `pnpm test` includes the new fixture.

## 3. Catalog pruning — the invoice is the root

217 of 236 `inventory_items` were created by recipe drafting, not by an invoice. Add `inventory_items.origin` (`invoice | recipe_draft | manual`, backfilled: any item with an `invoice_lines` row → `invoice`, else `recipe_draft`) and `first_invoiced_at`. Add a view `catalog_health`: per item, origin, days since created, whether any invoice line has ever mapped to it, recipe usage in the last 30 days, and a `status` of `confirmed` (has an invoice), `pending` (draft, < 30 days old), `orphan` (draft, ≥ 30 days, no invoice), `dormant` (invoice-born but no purchase in 90 days). The sku-match prompt already prefers existing items; make sure a draft-born item with a plausible name match wins over creating a duplicate (add a fixture: invoice line "TITOS VODKA 750" must map to the existing draft-born "Tito's Handmade Vodka", not create a second). Surface it as a small section at the bottom of `/inventory`: "N ingredients have never appeared on an invoice" with a one-tap merge-into or archive. Archive = `archived_at`, excluded from verify queue and daily position, never deleted.

**Gate 3.** `catalog_health` returns the expected counts; the merge fixture passes; `daily_position` for archived items stops being computed.

## 4. Quote sender identity

Replies must come from the restaurant, not another venture. Add `RESEND_FROM_DOMAIN` and `RESEND_FROM_NAME` env (Vercel + `.env.example` by name). If a Mad Moose domain is verified in Resend, use it; if not, verify `madmoosebarandgrill.com` sending via the Resend API (add the DNS records it returns to the report — Eric adds them) and until it verifies, hold quote sends with `status = 'blocked_sender'` rather than sending from the wrong domain. Reply-to stays the inbound address. Update the email copy to sign as the location name and the owner's first name from `tenants`.

**Gate 4.** `pnpm quotes:request --dry` prints a From header on the correct domain or reports `blocked_sender` with the DNS records needed; nothing sends from `macroseer.com` (grep the codebase and env).

## 5. 86-list from `stock:read`

`GET /stock/v1/inventory` (Toast Stock API; inspect the payload first with the Toast MCP or a one-off call through `lib/toast`) returns per-menu-item status `IN_STOCK | OUT_OF_STOCK | QUANTITY` with a `quantity` where set. Add `menu_item_stock_events(location_id, toast_menu_item_guid, status, quantity, observed_at)`, appended by the existing 5-minute `toast-sync` when the status differs from the last observed row (so the table is events, not snapshots). Use it in two places: the verify screen shows "86'd since Fri 8:40 pm" on any ingredient whose top menu item is out of stock, and `daily_position` records `stockout_minutes` per ingredient-day so a low-usage day with a stockout reads as explained, not as variance. Rule 1 still holds: read-only, `stock:read` is already in the token.

**Gate 5.** After one sync, `menu_item_stock_events` has rows; toggling a test item 86'd in Toast Web is not required — verify the poller diff logic with a fixture instead.

## 6. Labor beside pour cost

`GET /labor/v1/timeEntries?startDate&endDate` (already 200 with the token; inspect one page first). Add `labor_entries(location_id, toast_guid, employee_guid, job_title, business_date, clock_in, clock_out, regular_hours, overtime_hours, wage, tips_declared, cash_tips, non_cash_tips)` synced daily by `menu-sync`'s cron (rename that route to `daily-sync` if it is cleaner, keeping the schedule) with the same 36-hour re-pull window as orders. No PII beyond employee guid and job title; do not request `labor.employees:read` details. Add `daily_labor(location_id, business_date, hours, labor_cost, tips)` as a view and put labor cost and labor % of net sales on the `/position` page beside pour cost. Backfill 90 days.

**Gate 6.** `daily_labor` for the last full week sums to hours that match Toast Web's labor summary within 1 % (Eric can eyeball; put the numbers in the report), and `/position` renders both cost lines on a phone width.

## Housekeeping (do inside item 4's commit)

Rotate `RESEND_API_KEY` (it was printed in an old report): create a new key in Resend via API, set it on Vercel and `.env.local`, delete the old one, and never print either.

## Finish

`docs/REPORT-3.md`: per item, what changed and the gate result with numbers from `execute_sql`; every setting Eric still owes (portal creds if absent, DNS records, GitHub secrets) by name; and the one-line cmd to re-run each new script. Update `CLAUDE.md` (layout, rules, crons) and `docs/BLUEPRINT.md` §5 and §11 so nothing that now exists still says planned. Confirm the production deployment is READY through the Vercel MCP, and stop.
