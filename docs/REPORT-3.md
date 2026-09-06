# REPORT-3 — KICKOFF-3 build (2026-09-06)

Unattended build of `docs/KICKOFF-3.md` in the order the kickoff prescribes when `.env.portals` is absent: items 2, 3, 4, 5, 6, then item 1. Every gate number below was read from the live database (`execute_sql`) or the live runner, not from logs. Nothing here prints a secret value. Assumptions made without asking are in §8; what Eric still owes is in §9.

## 1. Where things stand

| Item | State | Commit |
|---|---|---|
| 2 Coca-Cola bag-in-box parse | **Gate PASS.** Ticket posted, 7 product lines on 7 distinct real products, CO2 sale + deposit ignored, cost/oz = extended ÷ 320 to 7 decimals. | `2f72de3` |
| 3 Catalog pruning | **Gate PASS.** `catalog_health`: confirmed 3 · pending 210 · dormant 22 · archived 1; Tito's fixture passes; archived items skipped by the reconciliation. | `ed98b25` |
| 4 Quote sender identity | **Gate PASS.** From header on `madmoosebarandgrill.com`; held as `blocked_sender` with the 3 DNS records; no `macroseer.com` in code or env. Key rotation refused by the permission classifier (§4). | `9ec0c42` |
| 5 86-list | **Gate PASS.** 35 stock events after one sync, 0 on the next; 5 ingredients show "86'd since …" on verify. | `13c5941` |
| 6 Labor | **Gate PASS (numbers for Eric's eyeball).** 876 entries / 78 dates backfilled; week Aug 24–30 = 418.99 h, $6,548.86. | `1ac7b04` |
| 1 Portal pull | **Partial.** No `.env.portals` on this machine → adapters not run against real portals. Built: saved-session support for 2FA portals, `pnpm portal:login`, GitHub secrets `XCHEF_BASE_URL` + `XCHEF_INTAKE_KEY`, and a green `workflow_dispatch` dry run against production (create → dedupe → attach). Template in §7. | `75283a8`, `63a0709` |
| Tree | `pnpm test` 20 files / 180 tests · `pnpm typecheck` · `pnpm lint` clean; every push deployed READY on Vercel (§10). | |

## 2. Item 2 — Coca-Cola bag-in-box tickets

What changed:

- **Migration 0014** (`20260906090000_beverage_distributor.sql`): `vendors.kind` gains `beverage_distributor` (Coca-Cola Beverages Northeast set); the learned mapping that pointed the header text "2.5 GALLO 1-Ls JUICE DRI" at the merged "Juice Drink" item is deleted and its lines reset.
- **Parser** (`lib/llm/invoice-parse.ts`): a paragraph on beverage-distributor tickets — bold category headers with a group count and subtotal are not lines; the product rows carry name, MAT#, QTY, PRICE, EXTENDED and a UPC on the next line; `vendor_sku` = MAT#; `pack_size_text` = "2.5 GAL BIB" read from "2.5GBIB"; the group family is appended in brackets to abbreviated names ("2.5GBIB GP PRE-LMND T [TEA]"); DEL DATE is the delivery date.
- **Packs** (`lib/core/packs.ts`): `DEFAULT_PACKS` gains 2.5 / 3 / 5 gal bag-in-box = 320 / 384 / 640 fl oz (9.46 L for 2.5 gal), recognized from "2.5GBIB", "2.5 GAL BIB", "BIB 2.5"; a parsed size still beats it and the mapping edit beats both.
- **`lib/core/beverage.ts`** (new, tested): `inferBibSize` (size from the product name when the pack column is empty), `isGasCylinderLine` (CO2 / cylinder / tank rental → ignored for beverage vendors, "gas is not tracked"), `familyHint` ("[TEA]" → iced tea when the name itself is unreadable).
- **`lib/core/nameMatch.ts`** (new, tested) and `resolveLine` step 3b: deterministic name matching against the catalog (details in §3). This is what lands "2.5GBIB COKE" on the draft-born "Coke (Fountain or Bottle)".
- **Map job** (`lib/jobs/mapInvoice.ts`): for beverage vendors, the BIB size is written into `pack_size_text` (flagged assumed) before resolution; `vendorKind` is passed to `resolveLine`.
- **SKU matcher prompt** (`lib/llm/sku-match.ts`): prefer an existing item whose name is the same product even with parenthetical qualifiers or a different brand spelling; a bag-in-box syrup is the fountain drink.
- **Fixture**: the Coke ticket was `fixtures/invoices/invoicesfarel4.pdf` (misnamed); renamed `coca-cola-ne-bib-ticket.pdf` with `coca-cola-ne-bib-ticket.expected.json` carrying line-level assertions (no header rows as lines, distinct MAT#s, `2.5 GAL BIB` packs, the `[TEA]` line). The real-model test passes.

Gate 2 (`execute_sql` on document `b6f3f50e-df7c-4e17-b2c1-6ad2cc00aa55`):

| line | description (as parsed) | item | qty base | cost / fl oz | expected (ext ÷ 320 per box) |
|---|---|---|---:|---:|---:|
| 1 | 2.5GBIB MM LMND NC [JUICE DRI] | Lemonade (Housemade or Pre-mix) | 640 | 0.20875 | 0.20875 |
| 2 | 2.5GBIB MMDR CRNBRY J [JUICE DRI] | Cranberry Juice | 320 | 0.373656 | 0.373656 |
| 3 | 2.5GBIB COKE [SPARKLING] | Coke (Fountain or Bottle) | 640 | 0.20875 | 0.20875 |
| 4 | 2.5GBIB DT COKE [SPARKLING] | Diet Coke (Fountain or Bottle) | 320 | 0.20875 | 0.20875 |
| 5 | 2.5GBIB SPRITE [SPARKLING] | Sprite (Fountain or Bottle) | 320 | 0.20875 | 0.20875 |
| 6 | 2.5GBIB SEAG G ALE [SPARKLING] | Ginger Ale (Fountain or Bottle) | 320 | 0.20875 | 0.20875 |
| 7 | 2.5GBIB GP PRE-LMND T [TEA] | Iced Tea (Housemade or Pre-mix) | 320 | 0.20875 | 0.20875 |
| 8 | 20#CYL CO2 FULL #1 [OTHER NON] | — ignored (gas) | | | |
| 9 | 20#CYL CO2 FULL #1 (deposit) | — ignored (deposit) | | | |

Document status `posted`, 7 mapped / 0 unmapped / 2 ignored, 7 distinct items, max relative cost error 6.7 × 10⁻⁷, Σ lines 733.97 = TOTAL PRODUCTS. Two re-parses were needed on the way: the first created a duplicate "Seagram's Ginger Ale (Bag in Box)" (fixed by the brand-in-front name rule) and mapped the tea line to Lemonade (fixed by the `[TEA]` family hint); both throw-away rows were removed.

## 3. Item 3 — catalog pruning

What changed:

- **Migration 0015** (`20260906100000_catalog_health.sql`): `inventory_items.origin` (`invoice | recipe_draft | manual`, backfilled: any item an invoice line ever mapped to → `invoice`, the rest → `recipe_draft`), `first_invoiced_at`, `archived_at`, `merged_into_id`; view **`catalog_health`** (origin, `days_since_created`, `has_invoice_line`, posted line count, last purchase date, recipe count, 30-day recipe usage, and `status` = `confirmed` | `pending` | `orphan` | `dormant` | `archived`); function **`merge_inventory_item(source, target)`** (recipes, invoice lines, mappings, quotes and counts move to the target; the source's derived `daily_position` rows are dropped; the source is archived with `merged_into_id`; membership checked); **`verification_queue`** excludes archived items.
- Jobs: the map job creates items with `origin = 'invoice'`, the post step stamps `first_invoiced_at`, the drafter creates `recipe_draft`, the form creates `manual`. Archived items are skipped by the daily reconciliation, the drafter, the SKU matcher's candidate list and the position picker.
- **Name-match guard** (`lib/core/nameMatch.ts`, used by `resolveLine`): tokens of the line and of each catalog name (lowercase, possessives and punctuation dropped, pack / size / packaging words dropped, ticket abbreviations expanded); a candidate matches when every line token is in its name — or every name token is in the line (a brand word in front of a stocked product) — with ≥ 60 % coverage, qualifiers (diet, zero, blanco, reposado, well, …) agreeing on both sides, and a unique best. Applied before the model when the pack is readable (no LLM call) and to any "new" or hesitant verdict afterwards. Fixture: `TITOS VODKA 750` with the model proposing a new "Tito's Vodka" maps to the existing "Tito's Handmade Vodka"; `VODKA 1.75L` alone does not claim it; `2.5GBIB DT COKE` never lands on Coke.
- **/inventory**: a section "N ingredients have never appeared on an invoice" (status pending / orphan) with, per row, a Merge-into select + button and an Archive button (44 px targets, one tap), plus a collapsed Archived list with Restore. The merged "Juice Drink" is archived.

Gate 3 (`execute_sql`):

| check | result |
|---|---|
| `catalog_health` by status | confirmed 3 · pending 210 · dormant 22 · archived 1 |
| `inventory_items.origin` | invoice 25 · recipe_draft 211 |
| never invoiced, active | 210 |
| `verification_queue` rows / archived among them | 235 / 0 |
| `pnpm position --from 2026-09-05 --to 2026-09-05` | 235 items processed; the archived item's row kept its 09:00 `computed_at`, active rows recomputed |
| merge fixture | `lib/core/resolveMapping.test.ts` "name match" block, passes |

## 4. Item 4 — quote sender identity

What changed:

- Env: `RESEND_FROM_DOMAIN` and `RESEND_FROM_NAME` (in `.env.example`, `.env.local`, Vercel production). `QUOTE_FROM_EMAIL` is no longer read anywhere.
- **`lib/jobs/quoteRequest.ts`**: From = `RESEND_FROM_NAME <quotes@RESEND_FROM_DOMAIN>`; `checkSender()` asks Resend's domains API once per run; while the domain is not `verified` every would-be send is recorded as `quote_requests.status = 'blocked_sender'` with the reason in the new `note` column and nothing goes out. Blocked rows do not count toward the 7-day cooldown. Reply-to stays `INBOUND_EMAIL_ADDRESS`.
- **Migration 0016** (`20260906110000_quote_sender.sql`): `tenants.owner_first_name` (Eric), the `blocked_sender` status, `quote_requests.note`. The email signs "Thanks, / Eric / Mad Moose Bar & Grill" (`lib/core/quotes.ts`, tested).
- `pnpm quotes:request --dry` prints From / Reply-To, the sender verdict and the DNS records; the "Ask for pricing" button explains a held request.

Gate 4: the dry run prints `From: Mad Moose Bar & Grill <quotes@madmoosebarandgrill.com>` for all three vendors with mappings (802 Spirits 17 items, Coca-Cola 7, Restaurant Depot 1), then `SENDER BLOCKED (status blocked_sender): madmoosebarandgrill.com is "failed" in Resend — its DNS records are not in place yet`. `grep macroseer` over the code, docs (other than REPORT-2) and `.env.local`: nothing.

DNS records Eric adds at the registrar for `madmoosebarandgrill.com` (Resend domain id `012a3efe-ef07-4ec6-a7cd-6cbfa366b278`, region us-east-1):

| record | type | name | value | priority |
|---|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7pwSjAa+LAb2WZo7g1/ZR4uJlTB4xQQfz1eqE+TYIPwiBOZTFVKyRHgUztPGycb3usgN8v/H6iTiMjB0CqUc3bihdqUDpfBjLJmJN/rRbYStRguKz7dDNk+DxQ6z9652SXCiWjqOREEf92f0EN3PsbzwXL2A9qKSPDbXfPSVxvwIDAQAB` | |
| SPF | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` | |

After they propagate, verify the domain in the Resend dashboard (the MCP `verify-domain` call was refused by the session's permission classifier); the next weekly cron sends normally and the held rows stay as history.

**Housekeeping not done — RESEND_API_KEY rotation.** The classifier refused both the rotation script (create key via API → `.env.local` → `vercel env add --force`) and `vercel env rm`. Procedure for Eric, no value ever typed into a terminal: Resend → API Keys → create `xchef-2026-09-06` (full access) → paste into `.env.local` and into Vercel (production + preview) `RESEND_API_KEY` → redeploy → delete the old keys named `xchef-inbound` and `RESEND_API_KEY` (both created 2026-09-04 by xchef). Also remove the now-unused `QUOTE_FROM_EMAIL` from Vercel production and preview.

## 5. Item 5 — 86-list

What changed:

- **`lib/toast/client.ts`**: `stockInventory()` (GET /stock/v1/inventory); auth untouched. Toast returns only `OUT_OF_STOCK` and `QUANTITY` items (`status=IN_STOCK` filter → 400), so absence = back in stock.
- **`lib/core/stock.ts`** (tested with the real payload shape): zod validation with quarantine, `diffStockObservations` (status change, QUANTITY count change, dropped-off-list → IN_STOCK), `stockoutMinutes` (minutes OUT_OF_STOCK inside a window from the event history), `fmtMinutes`. `lib/core/dates.ts`: `businessDayWindow` (4 a.m. local → 4 a.m. next day, DST-safe).
- **Migration 0017** (`20260906120000_stock_events.sql`): `menu_item_stock_events` (events, not snapshots), views `menu_item_stock_latest` and `ingredient_stockouts` (ingredient whose top menu item by 30-day units is currently OUT_OF_STOCK, with `since`), `daily_position.stockout_minutes`.
- **`lib/jobs/stockPoll.ts`** runs after every 5-minute `toast-sync` window (`runToastSync` returns `stock` summaries; `pollStock: false` opts out); it never fails the sync.
- Verify screen: "86'd since Fri 8:40 pm · Downeast Apple Pie is out of stock in Toast — low usage today is explained". `daily_position.stockout_minutes` = longest 86'd stretch among the ingredient's menu items in that business day; a change in minutes alone rewrites the row without a restatement. `/position` shows an 86'd column.

Gate 5: first `pnpm sync` after deploy → `stock-poll: observed 35, events 35` (32 OUT_OF_STOCK, 3 QUANTITY); the next sync → `events 0`; `ingredient_stockouts` = 5 rows (Downeast Apple Pie (Draft) 84 units/30d, Root Beer 16, Key Lime Pie 16, Cold Hollow Sparkling Apple Cider 12, Vermont Blonde Ale 4). 20 of the 35 86'd guids resolve to a named menu item; the other 15 are guids the menu sync does not carry (removed or hidden items) and are kept as events regardless.

## 6. Item 6 — labor

What changed:

- **`lib/toast/client.ts`**: `timeEntries(start, end)` and `jobs()`; Toast rejects windows over 30 days (`Cannot request time interval longer than 30 days`), so `lib/core/labor.ts` plans ≤ 30-day windows; a 90-day backfill is three calls. No pagination tokens are returned (301 entries in one page for 30 days).
- **`lib/core/labor.ts`** (tested): zod validation with quarantine, keeps only employee guid + job title (no employee endpoint), hours / wage / tips as fixed strings, `businessDate` → ISO.
- **Migration 0018** (`20260906130000_labor.sql`): `labor_entries` (unique per location + Toast guid), **`daily_labor`** (hours, regular, overtime, labor cost = regular × wage + overtime × wage × 1.5, tips), **`daily_cost_summary`** (net sales, theoretical usage cost, labor hours, labor cost, both as % of net sales).
- **`lib/jobs/laborSync.ts`**: `last window_end − 36 h → now`, backfill 90 days on first run, `sync_runs` kind `labor-sync`. **`/api/cron/menu-sync` is now `/api/cron/daily-sync`** (same `0 9 * * *`): menu sync then labor sync, each with its own error. `pnpm labor:sync [--days N]`.
- `/position`: a "Cost lines · last 14 days" block above the ingredient picker: per business day net sales, pour/food $ and %, labor $ and %, hours; the summary row shows the 14-day pour/food % and labor % at phone width.

Gate 6 — last full week, Mon 2026-08-24 → Sun 2026-08-30 (Aug 26 closed), for Eric to compare with Toast Web → Labor summary (target: hours within 1 %):

| day | hours | labor $ | net sales | labor % | pour/food $ | pour/food % |
|---|---:|---:|---:|---:|---:|---:|
| Mon 08-24 | 58.21 | 1,080.32 | 2,982.22 | 36.2 | 114.03 | 3.8 |
| Tue 08-25 | 64.28 | 1,119.18 | 4,411.00 | 25.4 | 133.30 | 3.0 |
| Thu 08-27 | 52.64 | 793.31 | 3,040.92 | 26.1 | 96.77 | 3.2 |
| Fri 08-28 | 115.09 | 1,460.06 | 6,864.97 | 21.3 | 179.59 | 2.6 |
| Sat 08-29 | 76.20 | 1,185.14 | 5,548.84 | 21.4 | 198.95 | 3.6 |
| Sun 08-30 | 52.57 | 910.85 | 3,503.74 | 26.0 | 139.39 | 4.0 |
| **week** | **418.99** (407.25 regular + 11.74 OT) | **6,548.86** | | | | |

Backfill: 876 entries, 78 business dates (2026-06-08 → 2026-09-05), 0 quarantined, 1.4 s. Job titles seen: Bartender, Busser, Chef, Cook, Dishwasher, General Manager, Lead Server, Owner, Server, Waitress. 82 entries have no hourly wage (salaried jobs) and count hours but $0 cost — labor $ understates by the salaried payroll. Pour/food % is low because most recipes are still unconfirmed drafts with no unit cost (the 25 invoice-born items are the only costed ones).

## 7. Item 1 — portal pull (partial)

`.env.portals` does not exist on this machine, so per the kickoff the adapters were not run and this item was done last. Built anyway:

- **Saved sessions for 2FA / "remember this device"**: `lib/portals/shared.ts` `loadPortalState` / `savePortalState`; `scripts/portal-pull.ts` opens the browser context with the saved state from `portal-state/<key>.json` (gitignored) or the base64 GitHub secret `PORTAL_<KEY>_STATE`; `.github/workflows/portal-pull.yml` passes `PORTAL_PFG_STATE` / `PORTAL_SYSCO_STATE`.
- **`pnpm portal:login --vendor pfg|sysco`**: headed Chromium at the portal's login page, credentials pre-filled from `.env.portals`, you finish the login (code, checkbox); when the URL leaves the login page (or you press Enter) the cookies + localStorage are saved. Re-auth = run it again and update the secret.
- **GitHub secrets set**: `XCHEF_BASE_URL`, `XCHEF_INTAKE_KEY` (same value as `INTAKE_API_KEY` on Vercel).
- **Workflow proven**: `gh workflow run portal-pull.yml -f dry_run=true` → run 34036156007 green after adding `tsx` as a devDependency (the runner had none — every `pnpm` script uses it). The dry run against production created a synthetic Restaurant Depot document (`source = 'api'`, posted, 3 lines, 2 mapped), then deduped the same bytes, then attached a byte-different copy as `clean_storage_path` (`execute_sql`: `has_clean_copy = true`, 3 `inbound_events` provider `portal`). The synthetic document, its two files and its events were then removed.
- Playwright MCP is not configured in this session (`claude mcp list`: toast, supabase, vercel, resend, github); the fallback is `npx playwright codegen <portal url>` plus the headless runner's screenshots.

`.env.portals` template (repo root, gitignored by `.env*`):

```
PORTAL_PFG_USER=
PORTAL_PFG_PASS=
PORTAL_SYSCO_USER=
PORTAL_SYSCO_PASS=
```

Then, in cmd:

```
pnpm portal:login --vendor pfg
pnpm portal:login --vendor sysco
pnpm portal:pull --vendor pfg --since 2026-08-23
gh secret set PORTAL_PFG_USER
gh secret set PORTAL_PFG_PASS
gh secret set PORTAL_SYSCO_USER
gh secret set PORTAL_SYSCO_PASS
certutil -encode portal-state\pfg.json pfg.b64 & findstr /v CERT pfg.b64 | gh secret set PORTAL_PFG_STATE & del pfg.b64
gh workflow run portal-pull.yml -f dry_run=false -f vendor=pfg
gh run watch
```

Gate 1 as written (a real portal, `clean_storage_path` on a real invoice) remains open until the credentials exist.

## 8. Assumptions made without asking

1. **Item order**: 2 → 3 → 4 → 5 → 6 → 1, as the kickoff says when `.env.portals` is absent.
2. **Family hints in descriptions**: the parser appends `[TEA]`-style brackets to abbreviated beverage product names; the map step uses them only when the name itself cannot be matched. The forbid-pattern in the fixture excludes header rows, not the brackets.
3. **Coke ticket date**: the model read the faint DEL DATE as 2023-12-18 twice; `invoice_date` / `received_date` were set to 2025-12-16 by hand (the printed date). Not asserted in the fixture.
4. **Name-match threshold** 60 % coverage either way; qualifiers list in `lib/core/nameMatch.ts` (diet, zero, blanco, reposado, well, …).
5. **`catalog_health.dormant`** = invoice-born with no posted purchase in 90 days (currently the Dec-2025 liquor and Coke items). **Merge** keeps the target's pack and cost unless null, drops the source's `daily_position` rows (recomputed by the nightly job as a restatement), archives the source.
6. **Held quotes are not auto-released**: once the domain verifies, the next weekly cron (or the button) sends fresh requests; `blocked_sender` rows stay as history.
7. **Owner first name** = "Eric" in `tenants.owner_first_name` (from the kickoff).
8. **Stock**: `QUANTITY` (a limited count) is not "86'd"; only `OUT_OF_STOCK` counts toward `stockout_minutes` and the verify chip. Minutes = the longest stretch among the ingredient's linked menu items, not a sum.
9. **Labor cost** = regular × wage + overtime × wage × 1.5; salaried entries (no hourly wage) contribute hours only; tips are shown separately and excluded from labor cost. Toast's `cashGratuityServiceCharges` → `cash_tips`, `nonCashTips + nonCashGratuityServiceCharges` → `non_cash_tips`, `declaredCashTips` → `tips_declared`.
10. **`/api/cron/menu-sync` was removed** (renamed `daily-sync`); the Settings "Sync menu now" button still calls the job directly.
11. **Security advisor** after the migrations: `purchases_by_item` and `item_price_history` had lost `security_invoker` in migration 0013 (KICKOFF-2) — restored by migration 0019, which also revokes `merge_inventory_item` from `anon`. The remaining warnings (security-definer RPCs callable by signed-in users, `convert_factor` search_path, leaked-password protection) predate this kickoff and are unchanged.
12. **`tsx`** is now a declared devDependency (the Actions runner had none; the lockfile had drifted).
13. One real-model fixture (`invoice802-1`) failed once in the full suite and passed on re-run and in every other run — model nondeterminism, not a code change.

## 9. What Eric still has to provide (names only)

| Setting | Where | Why |
|---|---|---|
| `PORTAL_PFG_USER`, `PORTAL_PFG_PASS`, `PORTAL_SYSCO_USER`, `PORTAL_SYSCO_PASS` | `.env.portals` locally, then `gh secret set` | run the adapters against the real portals (Gate 1) |
| `PORTAL_PFG_STATE`, `PORTAL_SYSCO_STATE` | GitHub secrets (base64 of `portal-state/<key>.json` from `pnpm portal:login`) | only if the portal asks for a one-time code |
| DNS records for `madmoosebarandgrill.com` (§4 table) | registrar | quote requests send from the restaurant's domain |
| `RESEND_API_KEY` rotation + delete `xchef-inbound` / `RESEND_API_KEY` keys; remove `QUOTE_FROM_EMAIL` from Vercel | Resend dashboard, Vercel, `.env.local` | refused by the permission classifier here (§4) |
| `vendors.contact_email` for each vendor | Settings → Vendors | nothing is emailed without it |
| Toast Web labor summary for Aug 24–30 | eyeball against §6 | Gate 6 |

## 10. Gate on the committed tree and production

| Check | Result |
|---|---|
| `pnpm test` | 20 files, 180 tests passed (real-model fixtures included) |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| Vercel | every push READY: `2f72de3`, `ed98b25`, `9ec0c42` (dpl_D6vB9L1m…), `13c5941`, `1ac7b04`, `75283a8` (dpl_2UJMujjg…), `63a0709` (dpl_F4wKAnUR…) — all `target: production`, `state: READY` (Vercel MCP `list_deployments`) |
| Migrations applied to xchef-dev via `apply_migration` | 0014 `beverage_distributor`, 0015 `catalog_health`, 0016 `quote_sender`, 0017 `stock_events`, 0018 `labor`, 0019 `security_invoker_fix`; all mirrored in `docs/schema.sql`; `lib/db/types.ts` regenerated |
| GitHub Actions | `portal-pull.yml` run 34036156007 green (dry run against production) |

## 11. Manual commands (cmd)

```
pnpm invoices:reparse --id b6f3f50e-df7c-4e17-b2c1-6ad2cc00aa55
pnpm invoices:remap --doc b6f3f50e-df7c-4e17-b2c1-6ad2cc00aa55
pnpm quotes:request --dry
pnpm sync --chunks 1
pnpm position --from 2026-09-05 --to 2026-09-05
pnpm labor:sync --days 90
pnpm portal:login --vendor pfg
pnpm portal:pull --dry
gh workflow run portal-pull.yml -f dry_run=true
```

Note: the global `pnpm` on this machine is 9.15 while the repo pins 10.28; if `pnpm` prints "packages field missing", use `corepack pnpm …`.
