# xchef — build report (2026-09-03)

**Production:** https://xchef.vercel.app — Vercel project `xchef`, deployment of `main` @ `fb930fc`, state READY.
**Repo:** https://github.com/ejv1234ny/xchef · **Database:** Supabase `xchef-dev` (`gqahyzoebifscqcrrkgq`).

## 1. What was built

All three phases from `docs/KICKOFF.md` Prompt F are implemented, committed, pushed and deployed:

| Area | Where |
|---|---|
| Toast client (login + token cache, `Toast-Restaurant-External-ID`, `/orders/v2/ordersBulk` pager at 4 req/s, menus v2, config) | `lib/toast/` |
| Flattening (rule 3) + synthetic fixture | `lib/core/flatten.ts`, `fixtures/toast/synthetic-orders.json` |
| Sales sync (36 h overlap, 90-day backfill in 7-day chunks, atomic `sales_facts` rebuild, `sync_runs`) | `lib/jobs/toastSync.ts`, `/api/cron/toast-sync`, `pnpm sync` |
| Menu sync (metadata `lastUpdated`, modifier options as rows) | `lib/jobs/menuSync.ts`, `/api/cron/menu-sync`, `pnpm menu:sync` |
| Auth (magic link), bootstrap, settings, Vault credentials | `proxy.ts`, `app/login`, `app/auth/callback`, `lib/db/context.ts`, `app/(app)/settings`, `pnpm creds` |
| Recipe drafting (Sonnet), Q&A queue, inventory, usage, plate cost | `lib/llm/recipe-draft.ts`, `lib/jobs/recipeDraft.ts`, `/recipes`, `/inventory`, `/usage`, `/menu` |
| Pack parsing, unit math, mapping resolver | `lib/core/packs.ts`, `units.ts`, `resolveMapping.ts` |
| Invoice parse (Sonnet PDF/image), SKU match (Haiku), intake/map/post jobs, spreadsheet import | `lib/llm/invoice-parse.ts`, `sku-match.ts`, `lib/jobs/{intake,parseInvoice,mapInvoice,postInvoice,importSpreadsheet}.ts` |
| Intake routes + Postmark webhook | `/api/intake/{upload,paste,manual}`, `/api/inbound/postmark/[secret]` |
| Verify (home), on-hand, prices, invoices, review | `app/(app)/page.tsx`, `/on-hand`, `/prices`, `/invoices`, `/invoices/review/[id]` |
| PWA (manifest, icons, service worker, offline, standalone, bottom tabs) | `app/manifest.ts`, `public/sw.js`, `public/icons/`, `components/tab-bar.tsx` |
| Demo data | `pnpm seed:demo`, `scripts/seed-demo.sql` (applied) |
| Migrations 0003–0005 (sync_runs + Vault RPCs, replace/relink sales_facts RPCs, llm_calls) | `supabase/migrations/`, mirrored in `docs/schema.sql` |

## 2. What was verified automatically, and how

| Check | Result |
|---|---|
| `pnpm test` | 7 files, **74 tests pass**: flatten fixture (voids at order/check/selection level, modifier with own `item.guid`, decimal weight item, 11:50 pm → 1:10 am tab on the earlier businessDate, refund not subtracted, idempotence); menu extraction + name dedupe; recipe queue ordering; units; every pack string in the brief (`6/#10` → range flag, `3/114OZ`, `12/750ML`, `4/1GAL`, `40 LB`, `CS`, `2/5LB`, `24/12OZ`, `1/6 BBL`, `50 LB BAG`, parsed-beats-default); mapping resolver (ketchup two vendors → Sysco ≈ half the cost per oz of Restaurant Depot with the #10 assumption visible, tomato price doubling → cost per lb doubles exactly, sku beats description, fee ignored, credit negates quantity) |
| `pnpm typecheck` (`next typegen && tsc --noEmit`), `pnpm lint`, `pnpm build` | clean; 21 routes built |
| Live routes | `/` → 307 `/login`; `/login` 200; protected pages → 307 with `?next=`; `/manifest.webmanifest` 200; `/sw.js` 200; icons 200; `/offline` 200; cron routes 401 without `CRON_SECRET`; intake/inbound routes reject GET (405) |
| Lighthouse 13.4 (mobile, simulated throttling) on `/login` | **Performance 100 · Accessibility 100 · Best practices 100 · SEO 91**; FCP 0.8 s, LCP 1.0 s, TBT 40 ms, CLS 0 (`docs/validation/lighthouse-login.json`) |
| PWA installability | Lighthouse 13 removed the PWA category; verified directly: manifest with `display: standalone`, `id`, 192/512 + maskable icons, `theme_color`; service worker served at `/sw.js` and registered in production; `mobile-web-app-capable` + `apple-mobile-web-app-title` + apple-touch-icon in `<head>` (Next 16 emits the standard tag; iOS 17+ honors it); HTTPS |
| Demo seed → SQL views | all seven money views return rows (`docs/validation/demo-seed.md`): `554 Classic Margarita → 831 oz Tequila – Blanco`; verification queue ordered never-verified first, tequila flagged "price up 46% in 30d"; count variance 14.24 oz = $24.58 = 0.56 bottles; ketchup Restaurant Depot → Sysco ≈ $668/yr |
| Toast MCP driver | `scripts/validate-pmix.ts` speaks MCP over stdio; probed against the community server in demo mode (4 synthetic orders returned) |
| Migrations | 0003–0005 applied to `xchef-dev` through the Supabase MCP; local files renamed to the versions the database records so `supabase db push` never re-applies 0001/0002 |

## 3. Three-day sales comparison

**Not run.** The service-role key arrived late in the session, but Toast credentials (`.env.toast`) were never provided, so nothing could be synced. The check is fully scripted:

```bash
pnpm creds && pnpm sync            # repeat `pnpm sync` until "Caught up."
for d in <day1> <day2> <day3>; do pnpm tsx scripts/validate-pmix.ts --date $d; done
```

Each run appends a per-item table to `docs/validation/phase1.md` with three columns: A = `sales_facts` (the app), B = an independent naive walk of the raw ordersBulk JSON (no shared code), C = the Toast MCP `toast_find_orders` count by item name (sanity only: it has no item GUID, no per-selection void flag, and caps at 100 orders per call, which is flagged). A ≠ B on any item is a FAIL. Σ `net_sales` is compared with Σ `check.amount`.

## 4. Assumptions and deviations from CLAUDE.md

1. **No shadcn/ui.** Plain Tailwind v4 utilities with 44 px (56 px primary) targets; installing shadcn would have added a dependency tree for no phone-first gain.
2. **Secrets not set → runtime paths guarded, never crashed.** Every LLM path checks `isAnthropicConfigured()`; without the key, parsing leaves documents `received` with `parse_error`, mapping still works from existing `vendor_item_mappings`, recipe drafting reports an error banner.
3. **Transactions via RPC.** supabase-js has no client transactions, so `replace_sales_facts(location, dates[], rows)` does the delete + insert in one call (migration 0004). `relink_sales_facts` fixes `menu_item_id` after a menu sync.
4. **Vault via security-definer RPCs** (`set_toast_credentials`, `get_toast_client_secret`, migration 0003). Members can set; only the service role can read.
5. **Migrations renamed** to `20260904002855_init.sql` / `20260904002929_rls.sql` (the versions already in `supabase_migrations.schema_migrations`) plus timestamped 0003–0005. Docs updated.
6. **Cron does ≤ 3 chunks per invocation** and advances `last_synced_at` per chunk so a 300 s function limit never loses progress.
7. **Storage bucket is created at runtime** by the service role (`ensureInvoicesBucket`) because the MCP database role cannot see `storage.buckets`.
8. **Modifier names for recipe drafting** come from `menu_items.category = 'modifier'` as hints; menus v2 references are not persisted per item after sync.
9. **`llm_calls` table (migration 0005)** stores raw output and cost for recipe drafts and SKU matches; invoice parses also keep `invoice_documents.raw_extraction`.
10. **Menu-sync runs reuse `sync_runs`** with `window_end = menus metadata lastUpdated`, `orders_upserted = items`, `orders_fetched = modifier options`.
11. **Postmark IP allowlist** is enforced in production only (override with `POSTMARK_IP_ALLOWLIST`), and returns 403 rather than a silent 200 — only after the path secret matched, so vendors are never bounced.
12. **`net_sales`** sums `selection.price` for non-voided lines (modifier rows carry their own price). Informational only, as the architecture states.
13. **Ketchup fixture** asserts "about half" (0.49–0.51 ratio) because at the 106 oz #10 default the ratio is 0.5002, not strictly below 0.5.
14. **Demo rows live in the real database** (`toast_menu_item_guid = 'demo-*'`, `content_hash = 'demo-N'`). Removal SQL is in `docs/validation/demo-seed.md`; delete them before the Product Mix comparison or the demo dates will show extra rows in `pnpm pmix`.
15. **Restaurant Depot spreadsheet import** parses 15 receipts / 333 lines offline (`pnpm invoices:import-xlsx --dry`); the live import was not executed (no service-role key).

## 5. Only you can do these

1. **Run STEP 0** (the block printed earlier, or fill `.env.local` + `.env.toast` by hand and `vercel env add` the four secrets): `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (CLI only), `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET`. Everything already deployed will start working without a redeploy for server-side reads; redeploy once after adding env vars so the cron/webhook functions pick them up (`vercel redeploy` or an empty commit).
2. **Supabase Auth URL configuration:** Authentication → URL Configuration → Site URL `https://xchef.vercel.app`, Redirect URLs add `https://xchef.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`. Without this the magic link lands on localhost.
3. **Vercel plan:** `vercel.json` schedules `/api/cron/toast-sync` every 5 minutes and both routes set `maxDuration = 300`; Hobby allows only daily crons and shorter functions, so the project must be on Pro (CLAUDE.md assumes it).
4. **Sign in once** at https://xchef.vercel.app/login (magic link). The first login creates tenant "Mad Moose", the location and your owner membership. Then Settings → store Toast credentials (or `pnpm creds`).
5. **Sales truth:** `pnpm sync`, then the three-day check above, then spot-check one day against Toast Web → Reports → Product Mix.
6. **Pour sizes:** `/recipes` — accept or edit the top 10 items (tequila in the margarita first).
7. **Vendor address change:** give Sysco / Restaurant Depot / the produce vendor `22714cd05547c0dd0827e942fe3a47ed@inbound.postmarkapp.com` as the billing email, or forward one invoice to it and watch `/invoices`.
8. **Postmark end-to-end email:** not sent — no mail client or Postmark server token was available, and the webhook returns 404 until `POSTMARK_INBOUND_SECRET` is set on Vercel. After STEP 0: forward any invoice PDF to the address above; a row appears in `/invoices` within a minute.
9. **Real invoice fixtures:** `pnpm tsx scripts/gen-invoice-expected.ts` (needs the Anthropic key) writes `fixtures/invoices/*.expected.json` so `lib/llm/invoice-parse.test.ts` runs against the 25 Mad Moose PDFs; then `pnpm invoices:replay` posts them and `pnpm invoices:import-xlsx` loads the Restaurant Depot receipts.

## 6. Not finished, and why (one line each)

- Three-day Product Mix self-check: no Toast credentials / service-role key in the session.
- Recipe drafts for items sold in the last 30 days: no `ANTHROPIC_API_KEY` and no synced sales.
- Invoice fixture expected JSON + replay + spreadsheet import against the database: same two secrets.
- Postmark test email: no sending client or server token; webhook secret unset on Vercel.
- `supabase db pull`: Supabase CLI not logged in (needs `npx supabase login` in a browser); migrations were applied and mirrored by hand instead.

## 7. Spreadsheet intake (added 2026-09-04)

`.csv .tsv .xlsx .xls` (≤ 5 MB) are accepted everywhere a PDF or photo is: the upload button on `/invoices`, `/api/intake/upload`, and Postmark attachments. `lib/jobs/parseSpreadsheet.ts` replaces the LLM parse for these: header-row detection → column map → `invoice_lines` written directly → one `invoice_documents` row per (invoice number, date) group (extra groups become sibling documents pointing at the same stored file) → the unchanged map → post jobs. Column maps come from, in order: a saved `vendor_sheet_layouts` row (migration 0006, keyed by a sha256 fingerprint of the normalized header) → a known layout in `lib/core/sheets.ts` → Haiku once (`sheet-map`, logged in `llm_calls`) → header-synonym heuristic. The review screen renders the source rows with a role `<select>` per column; saving stores a human-confirmed layout and re-parses.

| layout | how mapped |
|---|---|
| Restaurant Depot receipt transcription (`Description · Item Code · Pack / Detail · Units · Amount`, Transaction/tallies rows above) | deterministic (`KNOWN_LAYOUTS`) |
| Restaurant Depot items-by-category export | deterministic (`KNOWN_LAYOUTS`) |
| Sysco / US Foods / PFG order-guide and invoice exports | AI-mapped once per header, then remembered; promote to `KNOWN_LAYOUTS` when real samples arrive |
| anything else | AI-mapped once (Haiku), heuristic fallback when the API is unavailable |

Verified with `pnpm invoices:replay` over the four committed synthetic fixtures (known layout, unknown layout, multi-invoice sheet, totals rows): all posted; the multi-invoice sheet produced two documents; `Subtotal / Sales Tax / Total` rows were skipped at parse time and the fuel-surcharge line was ignored by mapping. `lib/core/sheets.test.ts` covers the same four cases plus cell parsers (13 tests).

## 8. Inbound email via Resend (added 2026-09-04)

`/api/inbound/resend` replaces Postmark. Resend posts `email.received` (metadata only) signed with Svix; the route verifies `svix-id`/`svix-timestamp`/`svix-signature` against `RESEND_WEBHOOK_SECRET` (manual HMAC-SHA256 over `${id}.${timestamp}.${body}`, ±5 min, 401 on failure), answers 200 immediately, and in `after()` fetches each usable attachment (pdf/jpg/png/heic/webp/csv/tsv/xlsx/xls) through `GET /emails/receiving/{email_id}/attachments/{id}` with `RESEND_API_KEY`, downloads it, and hands the bytes to the same `createInvoiceDocument` → parse → map → post pipeline (dedupe on content hash and Message-ID; `Fwd:`/`FW:` subjects become source `forward` with the original sender recovered from the body). An email with no usable attachment stores its text body as a plain-text document. Every delivery is logged in `inbound_events` (migration 0007). Helpers shared with the deprecated Postmark route live in `lib/inbound/shared.ts`.

Resend side (done through the Resend MCP): webhook `0182b97d…` → `https://xchef.vercel.app/api/inbound/resend` (event `email.received`, enabled); API key `xchef-inbound` (full access). Both secrets are in `.env.local` and on Vercel (production + preview). Receiving uses Resend's default `<id>.resend.app` subdomain for now (any local part → the Mad Moose location); a custom domain needs an MX record later. The address itself is shown on `/invoices` and `/settings` from `INBOUND_EMAIL_ADDRESS`.

Tests (`lib/inbound/resend.test.ts`, 7): valid/multi-entry/tampered/wrong-secret/missing-header/stale-timestamp signatures, payload parsing, attachment filtering, forward detection, and an integration test against `xchef-dev` with a mocked Resend API asserting one `invoice_documents` row and one `inbound_events` row (skipped when no service-role key).
