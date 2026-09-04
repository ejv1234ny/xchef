# xchef (working name)

Phone-first restaurant usage & inventory app beside Toast POS. Start with `CLAUDE.md`, then `docs/KICKOFF.md` for the Claude Code prompts and `docs/REPORT.md` for the current build status. Data layer: `docs/schema.sql` (applied as `supabase/migrations/20260904002855_init.sql` + later migrations). Full design: `docs/architecture.md`.

Production: https://xchef.vercel.app · Supabase project `xchef-dev` (ref `gqahyzoebifscqcrrkgq`, us-east-1).

## Run locally

```bash
corepack pnpm install               # pnpm 10 (pinned in package.json)
cp .env.example .env.local           # fill the secrets
corepack pnpm dev
```

## Commands

| command | what |
|---|---|
| `pnpm creds` | store Toast client id/secret + location GUID in Supabase Vault (reads `.env.toast`, prompts otherwise) |
| `pnpm sync` | pull orders (first run: 90 days, 7-day chunks) and rebuild `sales_facts`; repeat until "Caught up." |
| `pnpm pmix --date YYYY-MM-DD` | SUM(quantity_sold) per item for one business date, for Toast Product Mix comparison |
| `pnpm tsx scripts/validate-pmix.ts --date …` | three-way self-check (app vs raw walk vs Toast MCP), appends to `docs/validation/phase1.md` |
| `pnpm menu:sync [--force]` | Menus v2 → `menu_items` (modifier options as rows) |
| `pnpm recipes:draft [--limit N]` | Sonnet recipe drafts for items sold in the last 30 days |
| `pnpm invoices:replay [--dir …]` | run every fixture invoice through parse → map → post |
| `pnpm invoices:import-xlsx [--dry]` | Restaurant Depot receipts spreadsheet → manual invoices |
| `pnpm seed:demo` | tequila / ketchup / tomato demo data so every screen renders |
| `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm build` | before every commit |
| `pnpm db:push` · `pnpm db:types` | apply new migrations / regenerate `lib/db/types.ts` (needs `supabase login` + `supabase link`) |

Cron: `/api/cron/toast-sync` every 5 min, `/api/cron/menu-sync` daily (`vercel.json`, `CRON_SECRET`). Inbound invoices: Postmark → `/api/inbound/postmark/{POSTMARK_INBOUND_SECRET}`.
