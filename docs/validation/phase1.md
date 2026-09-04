# Phase 1 validation — sales truth

**Status: NOT YET RUN.** The self-check needs Toast credentials in Vault (`pnpm creds`)
and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, neither of which was available in
the build session (STEP 0 was not executed). Everything below is ready to run.

## How to run (10 minutes)

```bash
pnpm creds                     # reads .env.toast, stores the secret in Vault
pnpm sync                      # 90-day backfill in 7-day chunks; re-run until "Caught up."
pnpm pmix --date 2026-09-01    # eyeball one day
# self-check for the three most recent complete business days:
for d in 2026-09-01 2026-09-02 2026-09-03; do pnpm tsx scripts/validate-pmix.ts --date $d; done
```

Each run appends a section here with three independent counts per item:

| column | source | what it proves |
|---|---|---|
| A pmix | `sales_facts`, rebuilt by `lib/core/flatten.ts` through `replace_sales_facts` | the app's number |
| B raw walk | a second, deliberately naive walk of the raw `ordersBulk` JSON (`scripts/validate-pmix.ts`, no shared code with flatten) | flattening rules applied twice, independently |
| C MCP | community Toast MCP `toast_find_orders` for the business-day window, summed by item **name** | sanity check only: no item GUID, no per-selection void flag, capped at 100 orders per call (flagged when truncated) |

A ≠ B on any item is a FAIL: fix `lib/core/flatten.ts`, extend `fixtures/toast/synthetic-orders.json`,
re-run `pnpm sync` (sales_facts is rebuilt idempotently) and the check.

Σ `net_sales` (A) vs Σ `check.amount` (B) is informational: `net_sales` sums
`selection.price`, check amounts are after check-level discounts and service charges.

## Spot-check against Toast Web (only you can do this)

Toast Web → Reports → Sales → Product Mix, one business date, "Items" tab. Compare the
**Qty sold** column to column A. Known, intentional differences:

- Refunds are not subtracted (product was consumed).
- Modifiers with their own menu item (e.g. "Sub Patrón") appear as their own rows.
- Product Mix "Net sales" per item is after item discounts; `net_sales` here is `selection.price`.

## Results

(appended by `scripts/validate-pmix.ts`)
