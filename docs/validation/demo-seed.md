# Demo seed validation (xchef-dev, 2026-09-03)

`scripts/seed-demo.sql` was executed against `xchef-dev` through the Supabase MCP
(`pnpm seed:demo` is the same dataset via the service-role client). It is idempotent.
Row counts and headline numbers straight from the views afterwards:

| view | rows | headline |
|---|---:|---|
| `sales_facts` | 42 | 14 business dates × 3 demo menu items (`toast_menu_item_guid` = `demo-*`) |
| `usage_by_menu_item` | 5 | **554 Classic Margarita → 831.0 oz Tequila – Blanco**, 277 oz Simple Syrup, 554 Limes; 567 Moose Burger → 56.7 lb Tomatoes, 567 oz Ketchup |
| `menu_item_cost` | 3 | plate cost / cost % for margarita, burger, modifier |
| `on_hand_estimate` | 5 | one row per inventory item for the location |
| `verification_queue` | 5 | order: Tomatoes (never verified, score 1e9+528) · Limes (never verified) · Simple Syrup (never verified) · **Tequila – Blanco: "price up 46% in 30d", ~2.3 packs, score 1403** · Ketchup: routine, ~2.3 packs, score 44 |
| `count_variance` | 1 | tequila: expected − counted = **14.24 oz = $24.58 = 0.56 bottles** (short) |
| `vendor_price_comparison` | 2 | ketchup at Sysco (6 × 106 oz assumed, #10 range) vs Restaurant Depot (3 × 114 oz) |
| `vendor_switch_savings` | 1 | **Ketchup: Restaurant Depot → Sysco ≈ $668/yr** |
| `unit_cogs_master` | 5 | latest cost per base unit + per pack for every item |

Negative on-hand for Limes / Simple Syrup is expected: never verified and never purchased
in the demo, so the estimate is "net change since first invoice" (usage only) — exactly the
case the Verify screen labels "never verified — set a baseline".

## Removing the demo rows

Everything demo-specific is keyed by `demo-*` guids / `demo-N` content hashes:

```sql
delete from sales_facts where toast_menu_item_guid like 'demo-%';
delete from invoice_documents where content_hash like 'demo-%';       -- cascades to invoice_lines
delete from vendor_item_mappings where vendor_sku in ('1234567','2345678','3456789','RD-8891');
delete from stock_counts where inventory_item_id in (select id from inventory_items where name in ('Tequila - Blanco','Ketchup'));
delete from recipe_components where menu_item_id in (select id from menu_items where toast_menu_item_guid like 'demo-%');
delete from menu_items where toast_menu_item_guid like 'demo-%';
-- inventory_items / vendors are real-world names; keep or delete by hand.
```
