# Phase 1 validation — sales truth

**Status: RUN 2026-09-05** against live Toast data (credentials in Vault since 2026-09-05; 6,251 orders synced Jun 7 – Sep 5). Results for the last three business days with sales are appended below.

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

(appended by `scripts/validate-pmix.ts`; demo seed rows removed before this run; Sep 2 was a closed day)
## Business date 2026-09-01

Generated 2026-09-05T14:55:11.754Z · location Mad Moose Bar & Grill · tz America/New_York · closeout 4:00 local

| item | A pmix (sales_facts) | B raw walk | Δ | C MCP by name |
|---|---:|---:|---:|---:|
| French Fries #82f8 | 21.00 | 21.00 |  |  |
| Wings | 14.00 | 14.00 |  | 14.00 |
| Blue cheese | 11.00 | 11.00 |  |  |
| Mad Moose Burger | 9.00 | 9.00 |  | 9.00 |
| 6 | 8.00 | 8.00 |  |  |
| 16" Cheese Pizza | 7.00 | 7.00 |  | 6.00 |
| Fries | 7.00 | 7.00 |  |  |
| House Dry Rub | 7.00 | 7.00 |  |  |
| ---Whole Pizza--- | 6.00 | 6.00 |  |  |
| 10 | 6.00 | 6.00 |  |  |
| Buffalo | 6.00 | 6.00 |  |  |
| Cobb Salad | 6.00 | 6.00 |  | 6.00 |
| Good Measure, Riser Ale - Cream Ale | 6.00 | 6.00 |  | 6.00 |
| House Margarita | 6.00 | 6.00 |  | 6.00 |
| Maple Balsamic Vinaigrette | 6.00 | 6.00 |  |  |
| Sweet Potato Fries #4e2c | 6.00 | 6.00 |  |  |
| Bacon Burger | 5.00 | 5.00 |  | 5.00 |
| Blackberry Bacon Jalapeno Burger | 5.00 | 5.00 |  | 5.00 |
| Maine Lunch - IPA | 5.00 | 5.00 |  | 5.00 |
| Pepperoni | 5.00 | 5.00 |  |  |
| Swiss Mushroom Smash Burger | 5.00 | 5.00 |  | 5.00 |
| Blackberry #99ac | 4.00 | 4.00 |  |  |
| Cheese Pizza 12" | 4.00 | 4.00 |  | 4.00 |
| Crispy Buffalo Chicken | 4.00 | 4.00 |  | 4.00 |
| espresso martini | 4.00 | 4.00 |  | 4.00 |
| Fiddlehead - IPA | 4.00 | 4.00 |  | 4.00 |
| Sugarbush Beet and Berry Salad | 4.00 | 4.00 |  | 4.00 |
| Sweet Potato Fries #ec36 | 4.00 | 4.00 |  |  |
| 16" Whiteout | 3.00 | 3.00 |  | 3.00 |
| Autumn Harvest Salad | 3.00 | 3.00 |  | 3.00 |
| Blue Cheese Dessing | 3.00 | 3.00 |  |  |
| Bourbon Smash | 3.00 | 3.00 |  | 3.00 |
| Espolon #022b | 3.00 | 3.00 |  |  |
| Fernland - sauvignon blanc | 3.00 | 3.00 |  | 3.00 |
| Garlic & Herb Knots | 3.00 | 3.00 |  | 3.00 |
| Glass #b69f | 3.00 | 3.00 |  |  |
| maple honey mustard | 3.00 | 3.00 |  |  |
| Marinara | 3.00 | 3.00 |  |  |
| Martini | 3.00 | 3.00 |  | 3.00 |
| Mini Moose Burger | 3.00 | 3.00 |  | 3.00 |
| No Tomato | 3.00 | 3.00 |  |  |
| Ranch #d9a1 | 3.00 | 3.00 |  |  |
| Shredded Mozzarela | 3.00 | 3.00 |  |  |
| Smoked Brisket | 3.00 | 3.00 |  | 3.00 |
| Whiteout 12" | 3.00 | 3.00 |  | 3.00 |
| 16" Margherita | 2.00 | 2.00 |  | 2.00 |
| 16" Ski Bum Special | 2.00 | 2.00 |  | 2.00 |
| Basalmic Vinaigrette | 2.00 | 2.00 |  |  |
| Black Bean Burger | 2.00 | 2.00 |  | 2.00 |
| Black Flannel German Pilsner | 2.00 | 2.00 |  | 2.00 |
| Bud Light - Bottle | 2.00 | 2.00 |  | 2.00 |
| Ceasar | 2.00 | 2.00 |  |  |
| Chicken Bacon Ranch | 2.00 | 2.00 |  | 2.00 |
| Chicken Tenders | 2.00 | 2.00 |  | 2.00 |
| Coke #1ccc | 2.00 | 2.00 |  |  |
| Fried Brussel Sprouts | 2.00 | 2.00 |  | 2.00 |
| Frost Beer works, little lush - Light IPA | 2.00 | 2.00 |  | 2.00 |
| Gluten Free Bun | 2.00 | 2.00 |  |  |
| Maple Chipotle | 2.00 | 2.00 |  |  |
| No Onion #40a7 | 2.00 | 2.00 |  |  |
| no pickled veg | 2.00 | 2.00 |  |  |
| No Tomato #8bdb | 2.00 | 2.00 |  |  |
| Prosciutto & Fig 12" | 2.00 | 2.00 |  | 2.00 |
| Ranch | 2.00 | 2.00 |  |  |
| Sausage | 2.00 | 2.00 |  |  |
| Smoky Bourbon BBQ Wrap | 2.00 | 2.00 |  | 2.00 |
| Soda Water | 2.00 | 2.00 |  |  |
| Spiked Lemonade | 2.00 | 2.00 |  | 2.00 |
| Strawberry | 2.00 | 2.00 |  |  |
| Switchback Ale, Amber Ale | 2.00 | 2.00 |  | 2.00 |
| Vermont Maple Mustard | 2.00 | 2.00 |  | 2.00 |
| Zero Gravity, Green State light - light lager | 2.00 | 2.00 |  | 2.00 |
| ---1st Half--- | 1.00 | 1.00 |  |  |
| 16" Bull Moose | 1.00 | 1.00 |  | 1.00 |
| 16" Forest Forager | 1.00 | 1.00 |  | 1.00 |
| 16" Prosciutto & Fig | 1.00 | 1.00 |  | 1.00 |
| Athletic Run Wild IPA N/A Beer - Can | 1.00 | 1.00 |  | 1.00 |
| Bacon #a525 | 1.00 | 1.00 |  |  |
| Banana Peppers | 1.00 | 1.00 |  |  |
| Basil Oil | 1.00 | 1.00 |  |  |
| BBCO, Its Complicated Being a Wizard  - Double IPA | 1.00 | 1.00 |  | 1.00 |
| Black Olives | 1.00 | 1.00 |  |  |
| Buffalo Soldier Wrap | 1.00 | 1.00 |  | 1.00 |
| Cabbot Cheddar Buffalo Chicken Dip | 1.00 | 1.00 |  | 1.00 |
| Chicken | 1.00 | 1.00 |  |  |
| Classic | 1.00 | 1.00 |  |  |
| Classic Grilled Cheese | 1.00 | 1.00 |  | 1.00 |
| Club Soda | 1.00 | 1.00 |  | 1.00 |
| Coke | 1.00 | 1.00 |  | 1.00 |
| Coleslaw #4d36 | 1.00 | 1.00 |  |  |
| Coleslaw #a20f | 1.00 | 1.00 |  |  |
| Cranberry Juice | 1.00 | 1.00 |  | 1.00 |
| cranberry juice #1ea8 | 1.00 | 1.00 |  |  |
| Di Majo - sangiovese | 1.00 | 1.00 |  |  |
| Diet Coke | 1.00 | 1.00 |  | 1.00 |
| Don Julio #53a0 | 1.00 | 1.00 |  |  |
| Edward- Pale Ale | 1.00 | 1.00 |  | 1.00 |
| Espolon | 1.00 | 1.00 |  | 1.00 |
| Flagship - Cabernet Sauvignon | 1.00 | 1.00 |  |  |
| Fries #75a1 | 1.00 | 1.00 |  |  |
| Gin and Tonic | 1.00 | 1.00 |  | 1.00 |
| Glass #010c | 1.00 | 1.00 |  |  |
| Glass #6bf9 | 1.00 | 1.00 |  |  |
| Glass #e169 | 1.00 | 1.00 |  |  |
| gluten free pizza | 1.00 | 1.00 |  |  |
| Gouda Burger | 1.00 | 1.00 |  | 1.00 |
| Grey goose | 1.00 | 1.00 |  | 1.00 |
| Grey Goose #0f1e | 1.00 | 1.00 |  |  |
| Grilled Chicken | 1.00 | 1.00 |  |  |
| Hornitoz | 1.00 | 1.00 |  | 1.00 |
| House Italian | 1.00 | 1.00 |  |  |
| Jack Daniel's | 1.00 | 1.00 |  | 1.00 |
| Lawsons Little sip - IPA | 1.00 | 1.00 |  | 1.00 |
| Lemonade | 1.00 | 1.00 |  | 1.00 |
| Mad River Salmon Caesar Salad | 1.00 | 1.00 |  | 1.00 |
| Maple Old Fashiond | 1.00 | 1.00 |  | 1.00 |
| Miller Light | 1.00 | 1.00 |  | 1.00 |
| Narragansett - Lager Can | 1.00 | 1.00 |  | 1.00 |
| no bell peppers | 1.00 | 1.00 |  |  |
| No horseradish mayo | 1.00 | 1.00 |  |  |
| No Lettuce #62db | 1.00 | 1.00 |  |  |
| No Onion #f961 | 1.00 | 1.00 |  |  |
| No Pickles | 1.00 | 1.00 |  |  |
| No Sauce #6946 | 1.00 | 1.00 |  |  |
| No Tomato #1577 | 1.00 | 1.00 |  |  |
| oil and vinegar | 1.00 | 1.00 |  |  |
| Parmesan Fries | 1.00 | 1.00 |  | 1.00 |
| Piggy Apple 12" | 1.00 | 1.00 |  | 1.00 |
| Prickly Mountain 12" | 1.00 | 1.00 |  | 1.00 |
| Root Beer | 1.00 | 1.00 |  | 1.00 |
| Rum and Coke | 1.00 | 1.00 |  | 1.00 |
| Side Buffalo | 1.00 | 1.00 |  |  |
| Side Salad | 1.00 | 1.00 |  | 1.00 |
| Side Salad #b77c | 1.00 | 1.00 |  |  |
| Side Vermont Maple Mustard | 1.00 | 1.00 |  |  |
| Ski Bum Special 12" | 1.00 | 1.00 |  | 1.00 |
| Small House Caesar salad | 1.00 | 1.00 |  | 1.00 |
| Smokey Bourbon BBQ | 1.00 | 1.00 |  |  |
| Soulmates Pre-Prohibition American Lager | 1.00 | 1.00 |  | 1.00 |
| Spinach | 1.00 | 1.00 |  |  |
| Strawberry #ff6f | 1.00 | 1.00 |  |  |
| sweet potato fries | 1.00 | 1.00 |  | 1.00 |
| Tanguray | 1.00 | 1.00 |  |  |
| Tito's | 1.00 | 1.00 |  | 1.00 |
| Tomato | 1.00 | 1.00 |  |  |
| Vermont Maple Mustard #6460 | 1.00 | 1.00 |  |  |
| Von Trapp, Golden Helles Lager | 1.00 | 1.00 |  | 1.00 |
| William Hill - Chardonnay | 1.00 | 1.00 |  | 1.00 |
| with Salmon | 1.00 | 1.00 |  |  |

- Orders: A 55 (raw table) · B 55 (fresh pull) · C 55 [live]
- Σ net_sales (A, selection.price non-voided) = $2694.75 · Σ check.amount (B, non-voided) = $2401.89 · Δ $292.86 (differences = check-level discounts/service charges, expected small)
- Items with A≠B: **0** → PASS

## Business date 2026-09-03

Generated 2026-09-05T14:55:15.411Z · location Mad Moose Bar & Grill · tz America/New_York · closeout 4:00 local

| item | A pmix (sales_facts) | B raw walk | Δ | C MCP by name |
|---|---:|---:|---:|---:|
| French Fries #82f8 | 13.00 | 13.00 |  |  |
| ---Whole Pizza--- | 10.00 | 10.00 |  |  |
| Bacon Burger | 9.00 | 9.00 |  | 9.00 |
| Mad Moose Burger | 9.00 | 9.00 |  | 9.00 |
| 16" Cheese Pizza | 8.00 | 8.00 |  | 8.00 |
| Autumn Harvest Salad | 8.00 | 8.00 |  | 8.00 |
| Maple Balsamic Vinaigrette | 8.00 | 8.00 |  |  |
| Good Measure, Riser Ale - Cream Ale | 7.00 | 7.00 |  | 7.00 |
| Miller Light | 7.00 | 7.00 |  | 7.00 |
| Wings | 7.00 | 7.00 |  | 7.00 |
| Zero gravity, conehead haze - Hazy IPA | 7.00 | 7.00 |  | 7.00 |
| BBCO, Its Complicated Being a Wizard  - Double IPA | 6.00 | 6.00 |  | 6.00 |
| Black Flannel German Pilsner | 6.00 | 6.00 |  | 7.00 |
| Cheese Pizza 12" | 6.00 | 6.00 |  | 6.00 |
| Chicken Caesar Wrap | 6.00 | 6.00 |  | 6.00 |
| maple honey mustard | 6.00 | 6.00 |  |  |
| Switchback Ale, Amber Ale | 6.00 | 6.00 |  | 6.00 |
| Tanqueray | 6.00 | 6.00 |  | 6.00 |
| Tonic Water #ebbf | 6.00 | 6.00 |  |  |
| Blackberry Bacon Jalapeno Burger | 5.00 | 5.00 |  | 5.00 |
| Blue cheese | 5.00 | 5.00 |  |  |
| Bud Light - Bottle | 5.00 | 5.00 |  | 5.00 |
| Buffalo | 5.00 | 5.00 |  |  |
| Fries | 5.00 | 5.00 |  |  |
| Frost Beer works, little lush - Light IPA | 5.00 | 5.00 |  | 5.00 |
| Long Trail, Long Trail Ale - Amber Ale | 5.00 | 5.00 |  | 5.00 |
| Pacifico - Bottle | 5.00 | 5.00 |  | 5.00 |
| Raspberry White Chocolate Cheesecake | 5.00 | 5.00 |  | 5.00 |
| Red Onion | 5.00 | 5.00 |  |  |
| Sugarbush Beet and Berry Salad | 5.00 | 5.00 |  | 5.00 |
| Swiss Mushroom Smash Burger | 5.00 | 5.00 |  | 5.00 |
| Tito's | 5.00 | 5.00 |  | 5.00 |
| 10 | 4.00 | 4.00 |  |  |
| Corvezzo - Pinot Grigio | 4.00 | 4.00 |  | 4.00 |
| Edward- Pale Ale | 4.00 | 4.00 |  | 4.00 |
| Fiddlehead - IPA | 4.00 | 4.00 |  | 4.00 |
| Fries #75a1 | 4.00 | 4.00 |  |  |
| glass | 4.00 | 4.00 |  |  |
| Gouda Burger | 4.00 | 4.00 |  | 4.00 |
| Grilled Chicken | 4.00 | 4.00 |  |  |
| Maple Old Fashiond | 4.00 | 4.00 |  | 4.00 |
| Mushrooms | 4.00 | 4.00 |  |  |
| Pepperoni | 4.00 | 4.00 |  |  |
| Prosciutto & Fig 12" | 4.00 | 4.00 |  | 4.00 |
| Side Salad #b77c | 4.00 | 4.00 |  |  |
| Soda Water | 4.00 | 4.00 |  |  |
| 6 | 3.00 | 3.00 |  |  |
| Ceasar | 3.00 | 3.00 |  |  |
| Chicken Bacon Ranch | 3.00 | 3.00 |  | 3.00 |
| Cobb Salad | 3.00 | 3.00 |  | 3.00 |
| french Fries | 3.00 | 3.00 |  | 3.00 |
| Garlic & Herb Knots | 3.00 | 3.00 |  | 3.00 |
| Lemonade | 3.00 | 3.00 |  | 3.00 |
| Mad River Salmon Caesar Salad | 3.00 | 3.00 |  | 3.00 |
| Maine Lunch - IPA | 3.00 | 3.00 |  | 3.00 |
| Margherita 12" | 3.00 | 3.00 |  | 3.00 |
| Side Fries | 3.00 | 3.00 |  | 1.00 |
| Smoky Bourbon BBQ Wrap | 3.00 | 3.00 |  | 3.00 |
| Spiked Lemonade | 3.00 | 3.00 |  | 3.00 |
| Well Shot | 3.00 | 3.00 |  | 3.00 |
| Well Vodka, Smirnoff | 3.00 | 3.00 |  | 3.00 |
| 16" Margherita | 2.00 | 2.00 |  | 2.00 |
| Arnold Palmer | 2.00 | 2.00 |  | 2.00 |
| Balsamic Vinaigrette | 2.00 | 2.00 |  |  |
| Bell Peppers | 2.00 | 2.00 |  |  |
| Budweiser Bottle | 2.00 | 2.00 |  | 2.00 |
| bullet bourbon | 2.00 | 2.00 |  | 2.00 |
| Cabbot Cheddar Buffalo Chicken Dip | 2.00 | 2.00 |  | 2.00 |
| Carrot Cake | 2.00 | 2.00 |  | 2.00 |
| Chicken | 2.00 | 2.00 |  |  |
| Coke #2b13 | 2.00 | 2.00 |  |  |
| Coleslaw #4d36 | 2.00 | 2.00 |  |  |
| Downeast Apple Pie | 2.00 | 2.00 |  | 2.00 |
| Fried Brussel Sprouts | 2.00 | 2.00 |  | 3.00 |
| Glass #ffd3 | 2.00 | 2.00 |  |  |
| Hornitoz | 2.00 | 2.00 |  | 2.00 |
| Jameson Irish | 2.00 | 2.00 |  | 2.00 |
| Lime garnish | 2.00 | 2.00 |  |  |
| Martini | 2.00 | 2.00 |  | 2.00 |
| No Cabot Cheddar #9667 | 2.00 | 2.00 |  |  |
| No Onion #40a7 | 2.00 | 2.00 |  |  |
| No Tomato #8bdb | 2.00 | 2.00 |  |  |
| Piggy Apple 12" | 2.00 | 2.00 |  | 2.00 |
| Ranch | 2.00 | 2.00 |  |  |
| Sprite #681b | 2.00 | 2.00 |  |  |
| Turkey Avocado Wrap | 2.00 | 2.00 |  | 2.00 |
| Vermont Maple Mustard | 2.00 | 2.00 |  | 2.00 |
| Vigneti Del Sole - Montepulciano | 2.00 | 2.00 |  |  |
| whiskey ginger | 2.00 | 2.00 |  | 2.00 |
| Whiteout 12" | 2.00 | 2.00 |  | 2.00 |
| with Salmon | 2.00 | 2.00 |  |  |
| 16" Bull Moose | 1.00 | 1.00 |  | 1.00 |
| 16" Forest Forager | 1.00 | 1.00 |  | 1.00 |
| 16" Whiteout | 1.00 | 1.00 |  | 1.00 |
| Arugula | 1.00 | 1.00 |  |  |
| Athletic Run Wild IPA N/A Beer - Can | 1.00 | 1.00 |  | 1.00 |
| bacon | 1.00 | 1.00 |  |  |
| Bacon #c574 | 1.00 | 1.00 |  |  |
| Black Olives | 1.00 | 1.00 |  |  |
| Blackberry | 1.00 | 1.00 |  |  |
| Blue Cheese #0843 | 1.00 | 1.00 |  |  |
| Blue Cheese Dessing | 1.00 | 1.00 |  |  |
| Buffalo Soldier Wrap | 1.00 | 1.00 |  | 1.00 |
| Buffalo Trace | 1.00 | 1.00 |  | 1.00 |
| Caesar | 1.00 | 1.00 |  |  |
| Classic | 1.00 | 1.00 |  |  |
| Club Soda | 1.00 | 1.00 |  | 1.00 |
| coleslaw #78a1 | 1.00 | 1.00 |  |  |
| Coleslaw #a20f | 1.00 | 1.00 |  |  |
| Cranberry Juice | 1.00 | 1.00 |  | 1.00 |
| Crispy Buffalo Chicken | 1.00 | 1.00 |  | 1.00 |
| Dr. Pepper | 1.00 | 1.00 |  | 1.00 |
| espresso martini | 1.00 | 1.00 |  | 1.00 |
| Extre Patty | 1.00 | 1.00 |  |  |
| Gin Martini - Tanguray | 1.00 | 1.00 |  |  |
| Glass #e169 | 1.00 | 1.00 |  |  |
| Gluten Free Bun | 1.00 | 1.00 |  |  |
| gluten free pizza | 1.00 | 1.00 |  |  |
| hard boiled egg | 1.00 | 1.00 |  |  |
| House Margarita | 1.00 | 1.00 |  | 1.00 |
| Iced Tea | 1.00 | 1.00 |  | 1.00 |
| Jalapenos | 1.00 | 1.00 |  |  |
| Lemon | 1.00 | 1.00 |  |  |
| Lemon garnish | 1.00 | 1.00 |  |  |
| Maker's Mark | 1.00 | 1.00 |  | 1.00 |
| Maple Chipotle | 1.00 | 1.00 |  |  |
| Marinara | 1.00 | 1.00 |  |  |
| No Arugula | 1.00 | 1.00 |  |  |
| No Avocado | 1.00 | 1.00 |  |  |
| No Bacon #d36e | 1.00 | 1.00 |  |  |
| No Basil | 1.00 | 1.00 |  |  |
| no bell peppers | 1.00 | 1.00 |  |  |
| No Blue Cheese Crumbles | 1.00 | 1.00 |  |  |
| No Blue Cheese Crumbles #9abb | 1.00 | 1.00 |  |  |
| No Cheddar | 1.00 | 1.00 |  |  |
| No Goat Cheese #a6b6 | 1.00 | 1.00 |  |  |
| No Hot Honey Drizzle | 1.00 | 1.00 |  |  |
| No Lettuce #62db | 1.00 | 1.00 |  |  |
| No Onion #f961 | 1.00 | 1.00 |  |  |
| No Pecorino #2d23 | 1.00 | 1.00 |  |  |
| No Pesto Oil | 1.00 | 1.00 |  |  |
| no pickle | 1.00 | 1.00 |  |  |
| No Ranch | 1.00 | 1.00 |  |  |
| No Roasted Garlic | 1.00 | 1.00 |  |  |
| No Spicy Aioli | 1.00 | 1.00 |  |  |
| No Spinach #685d | 1.00 | 1.00 |  |  |
| No Spinach #85bb | 1.00 | 1.00 |  |  |
| No Tomato | 1.00 | 1.00 |  |  |
| No Tomato #1577 | 1.00 | 1.00 |  |  |
| Orange Juice | 1.00 | 1.00 |  | 1.00 |
| Pinapple | 1.00 | 1.00 |  |  |
| Prickly Mountain 12" | 1.00 | 1.00 |  | 2.00 |
| Ranch #d9a1 | 1.00 | 1.00 |  |  |
| Rectified #0f4a | 1.00 | 1.00 |  |  |
| Sausage | 1.00 | 1.00 |  |  |
| Shredded Mozzarela | 1.00 | 1.00 |  |  |
| Ski Bum Special 12" | 1.00 | 1.00 |  | 1.00 |
| Sliced Apple | 1.00 | 1.00 |  |  |
| Smoked Brisket | 1.00 | 1.00 |  | 1.00 |
| Spinach Wrap | 1.00 | 1.00 |  |  |
| Strawberry | 1.00 | 1.00 |  |  |
| Sweet Potato Fries #4e2c | 1.00 | 1.00 |  |  |
| Sweet Potato Fries #ec36 | 1.00 | 1.00 |  |  |
| Tittos | 1.00 | 1.00 |  |  |
| Tomato Basil Wrap | 1.00 | 1.00 |  |  |
| Top Shelf Shot | 1.00 | 1.00 |  | 1.00 |
| Unsweetened | 1.00 | 1.00 |  |  |
| Vermont Maple Mustard #6460 | 1.00 | 1.00 |  |  |
| White Wrap | 1.00 | 1.00 |  |  |
| William Hill - Chardonnay | 1.00 | 1.00 |  | 1.00 |
| without salmon | 1.00 | 1.00 |  |  |
| Maple Balsamic Vinaigrette #13f3 | 0.00 | 0.00 |  |  |

- Orders: A 58 (raw table) · B 58 (fresh pull) · C 59 [live]
- Σ net_sales (A, selection.price non-voided) = $3089.62 · Σ check.amount (B, non-voided) = $2812.88 · Δ $276.74 (differences = check-level discounts/service charges, expected small)
- Items with A≠B: **0** → PASS

## Business date 2026-09-04

Generated 2026-09-05T14:55:18.764Z · location Mad Moose Bar & Grill · tz America/New_York · closeout 4:00 local

| item | A pmix (sales_facts) | B raw walk | Δ | C MCP by name |
|---|---:|---:|---:|---:|
| Mad Moose Burger | 35.00 | 35.00 |  | 30.00 |
| French Fries #82f8 | 28.00 | 28.00 |  |  |
| Bacon Burger | 22.00 | 22.00 |  | 19.00 |
| Wings | 22.00 | 22.00 |  | 16.00 |
| ---Whole Pizza--- | 15.00 | 15.00 |  |  |
| 16" Cheese Pizza | 15.00 | 15.00 |  | 10.00 |
| Edward- Pale Ale | 14.00 | 14.00 |  | 10.00 |
| House Margarita | 14.00 | 14.00 |  | 14.00 |
| Autumn Harvest Salad | 13.00 | 13.00 |  | 12.00 |
| Blue cheese | 13.00 | 13.00 |  |  |
| Ceasar | 12.00 | 12.00 |  |  |
| Gouda Burger | 12.00 | 12.00 |  | 9.00 |
| Sweet Potato Fries #4e2c | 12.00 | 12.00 |  |  |
| Switchback Ale, Amber Ale | 12.00 | 12.00 |  | 6.00 |
| Vermont Maple Mustard | 12.00 | 12.00 |  | 12.00 |
| 10 | 11.00 | 11.00 |  |  |
| 6 | 11.00 | 11.00 |  |  |
| Diet Coke | 11.00 | 11.00 |  | 11.00 |
| Fries | 11.00 | 11.00 |  |  |
| Sugarbush Beet and Berry Salad | 11.00 | 11.00 |  | 10.00 |
| Mad River Salmon Caesar Salad | 10.00 | 10.00 |  | 7.00 |
| Pepperoni | 10.00 | 10.00 |  |  |
| 16" Ski Bum Special | 9.00 | 9.00 |  | 7.00 |
| Maple Balsamic Vinaigrette | 9.00 | 9.00 |  |  |
| maple honey mustard | 9.00 | 9.00 |  |  |
| No Pickles | 9.00 | 9.00 |  |  |
| Side Salad #b77c | 9.00 | 9.00 |  |  |
| Smoked Brisket | 9.00 | 9.00 |  | 7.00 |
| Fried Brussel Sprouts | 8.00 | 8.00 |  | 7.00 |
| No Tomato | 8.00 | 8.00 |  |  |
| Pacifico - Bottle | 8.00 | 8.00 |  |  |
| Basalmic Vinaigrette | 7.00 | 7.00 |  |  |
| Blackberry #99ac | 7.00 | 7.00 |  |  |
| Buffalo Soldier Wrap | 7.00 | 7.00 |  | 6.00 |
| Chicken Bacon Ranch | 7.00 | 7.00 |  | 5.00 |
| Chicken Tenders | 7.00 | 7.00 |  | 7.00 |
| Coke | 7.00 | 7.00 |  | 7.00 |
| Garlic & Herb Knots | 7.00 | 7.00 |  | 6.00 |
| Iced Tea | 7.00 | 7.00 |  | 7.00 |
| Maple Old Fashiond | 7.00 | 7.00 |  | 7.00 |
| No Garlic Mayo | 7.00 | 7.00 |  |  |
| Peanut Butter Cake | 7.00 | 7.00 |  | 7.00 |
| Ranch #d9a1 | 7.00 | 7.00 |  |  |
| Turkey Avocado Wrap | 7.00 | 7.00 |  | 7.00 |
| Blackberry Bacon Jalapeno Burger | 6.00 | 6.00 |  | 5.00 |
| Chicken Caesar Wrap | 6.00 | 6.00 |  | 6.00 |
| Citizen Cider | 6.00 | 6.00 |  | 5.00 |
| Classic | 6.00 | 6.00 |  |  |
| Fries #75a1 | 6.00 | 6.00 |  |  |
| Good Measure, Riser Ale - Cream Ale | 6.00 | 6.00 |  | 3.00 |
| Maple Chipotle | 6.00 | 6.00 |  |  |
| No Onion #40a7 | 6.00 | 6.00 |  |  |
| Salmon | 6.00 | 6.00 |  |  |
| Salt Rim | 6.00 | 6.00 |  |  |
| Swiss Mushroom Smash Burger | 6.00 | 6.00 |  | 6.00 |
| Unsweetened | 6.00 | 6.00 |  |  |
| with Salmon | 6.00 | 6.00 |  |  |
| 16" Margherita | 5.00 | 5.00 |  | 5.00 |
| 16" Prosciutto & Fig | 5.00 | 5.00 |  | 4.00 |
| Apple Juice - bottle | 5.00 | 5.00 |  | 5.00 |
| BBCO, Its Complicated Being a Wizard  - Double IPA | 5.00 | 5.00 |  | 4.00 |
| Black Bean Burger | 5.00 | 5.00 |  | 5.00 |
| Black Flannel German Pilsner | 5.00 | 5.00 |  | 5.00 |
| Buffalo | 5.00 | 5.00 |  |  |
| Cabbot Cheddar Buffalo Chicken Dip | 5.00 | 5.00 |  | 5.00 |
| Cheese Pizza 12" | 5.00 | 5.00 |  | 5.00 |
| Chicken | 5.00 | 5.00 |  |  |
| Coleslaw #4d36 | 5.00 | 5.00 |  |  |
| Coleslaw #a20f | 5.00 | 5.00 |  |  |
| Crispy Buffalo Chicken | 5.00 | 5.00 |  | 5.00 |
| Dr. Pepper | 5.00 | 5.00 |  | 5.00 |
| Hornitoz | 5.00 | 5.00 |  |  |
| House Dry Rub | 5.00 | 5.00 |  |  |
| Lemonade | 5.00 | 5.00 |  | 5.00 |
| Margherita 12" | 5.00 | 5.00 |  | 4.00 |
| Mini Moose Burger | 5.00 | 5.00 |  | 5.00 |
| Parmesan Fries | 5.00 | 5.00 |  | 3.00 |
| Von Trapp, Golden Helles Lager | 5.00 | 5.00 |  | 5.00 |
| Zero gravity, conehead haze - Hazy IPA | 5.00 | 5.00 |  | 4.00 |
| 16" Whiteout | 4.00 | 4.00 |  | 2.00 |
| Blue Cheese Dessing | 4.00 | 4.00 |  |  |
| Carrot Cake | 4.00 | 4.00 |  | 3.00 |
| Cold Hollow Extra Dry Cider - Can | 4.00 | 4.00 |  | 4.00 |
| Fiddlehead - IPA | 4.00 | 4.00 |  | 6.00 |
| Gluten Free Bun | 4.00 | 4.00 |  |  |
| Maine Lunch - IPA | 4.00 | 4.00 |  | 4.00 |
| Marinara | 4.00 | 4.00 |  |  |
| Miller Light | 4.00 | 4.00 |  |  |
| No Lettuce | 4.00 | 4.00 |  |  |
| No Onion #f961 | 4.00 | 4.00 |  |  |
| Red Onion | 4.00 | 4.00 |  |  |
| Sausage | 4.00 | 4.00 |  |  |
| side salad #9b2a | 4.00 | 4.00 |  |  |
| Stella Artois - Bottle | 4.00 | 4.00 |  | 3.00 |
| Vermont Maple Mustard #6460 | 4.00 | 4.00 |  |  |
| without salmon | 4.00 | 4.00 |  |  |
| Zero Gravity, Green State light - light lager | 4.00 | 4.00 |  | 4.00 |
| 16" Forest Forager | 3.00 | 3.00 |  | 2.00 |
| Arnold Palmer | 3.00 | 3.00 |  | 3.00 |
| Balsamic Vinaigrette | 3.00 | 3.00 |  |  |
| Blueberry Blonde Ale, Rutland beer works | 3.00 | 3.00 |  | 2.00 |
| Club Soda | 3.00 | 3.00 |  | 3.00 |
| Corvezzo - Pinot Grigio | 3.00 | 3.00 |  | 3.00 |
| espresso martini | 3.00 | 3.00 |  |  |
| glass | 3.00 | 3.00 |  |  |
| Grilled Chicken | 3.00 | 3.00 |  |  |
| Mushrooms | 3.00 | 3.00 |  |  |
| N\A Zero Gravity Green State Zero can | 3.00 | 3.00 |  | 3.00 |
| No Olives | 3.00 | 3.00 |  |  |
| No Tomato #8bdb | 3.00 | 3.00 |  |  |
| Shredded Mozzarela | 3.00 | 3.00 |  |  |
| Ski Bum Special 12" | 3.00 | 3.00 |  | 2.00 |
| Smoky Bourbon BBQ Wrap | 3.00 | 3.00 |  | 3.00 |
| Spiked Lemonade | 3.00 | 3.00 |  | 3.00 |
| Sweet Potato Fries #ec36 | 3.00 | 3.00 |  |  |
| ---2nd Half--- | 2.00 | 2.00 |  |  |
| 16" Bull Moose | 2.00 | 2.00 |  | 1.00 |
| 16" Prickly Mountain | 2.00 | 2.00 |  | 2.00 |
| Black Olives | 2.00 | 2.00 |  |  |
| Captain Morgan | 2.00 | 2.00 |  | 2.00 |
| Citizen Cider - Unified Press - Special | 2.00 | 2.00 |  | 2.00 |
| Classic Grilled Cheese | 2.00 | 2.00 |  | 2.00 |
| Cobb Salad | 2.00 | 2.00 |  | 1.00 |
| Coffee | 2.00 | 2.00 |  | 2.00 |
| Coke #2b13 | 2.00 | 2.00 |  |  |
| coleslaw #78a1 | 2.00 | 2.00 |  |  |
| Downeast Apple Pie | 2.00 | 2.00 |  | 2.00 |
| Fernland - sauvignon blanc | 2.00 | 2.00 |  | 2.00 |
| Flagship - Cabernet Sauvignon | 2.00 | 2.00 |  |  |
| Forest Forager 12" | 2.00 | 2.00 |  | 2.00 |
| french Fries | 2.00 | 2.00 |  | 2.00 |
| Glass #010c | 2.00 | 2.00 |  |  |
| Glass #b69f | 2.00 | 2.00 |  |  |
| Glass #e6ff | 2.00 | 2.00 |  |  |
| Hot Honey | 2.00 | 2.00 |  |  |
| Lawsons Little sip - IPA | 2.00 | 2.00 |  | 2.00 |
| Long Trail, Long Trail Ale - Amber Ale | 2.00 | 2.00 |  | 1.00 |
| Maple Balsamic Vinaigrette #13f3 | 2.00 | 2.00 |  |  |
| Maple Honey Mustard #a7b7 | 2.00 | 2.00 |  |  |
| no basil pesto sauce | 2.00 | 2.00 |  |  |
| No Blue Cheese Crumbles #9abb | 2.00 | 2.00 |  |  |
| No Cabot Cheddar | 2.00 | 2.00 |  |  |
| No Goat Cheese #a6b6 | 2.00 | 2.00 |  |  |
| No Mushrooms #b7e7 | 2.00 | 2.00 |  |  |
| No Spinach #685d | 2.00 | 2.00 |  |  |
| Pinapple | 2.00 | 2.00 |  |  |
| Prosciutto & Fig 12" | 2.00 | 2.00 |  | 2.00 |
| Root Beer | 2.00 | 2.00 |  | 2.00 |
| Shirley temple | 2.00 | 2.00 |  | 2.00 |
| Small House Caesar salad | 2.00 | 2.00 |  | 3.00 |
| Sprite | 2.00 | 2.00 |  | 2.00 |
| sweet potato fries | 2.00 | 2.00 |  | 1.00 |
| Tomato Basil Wrap | 2.00 | 2.00 |  |  |
| VRAC - Rose' | 2.00 | 2.00 |  |  |
| Water #0b44 | 2.00 | 2.00 |  |  |
| Whiteout 12" | 2.00 | 2.00 |  | 2.00 |
| ---1st Half--- | 1.00 | 1.00 |  |  |
| 16" Piggy Apple | 1.00 | 1.00 |  | 1.00 |
| Athletic Upside Down NA Beer - Can | 1.00 | 1.00 |  | 1.00 |
| Avocado | 1.00 | 1.00 |  |  |
| Bacon #a525 | 1.00 | 1.00 |  |  |
| Bacon #c574 | 1.00 | 1.00 |  |  |
| Balsamic | 1.00 | 1.00 |  |  |
| Banana Peppers | 1.00 | 1.00 |  |  |
| Bar Hill | 1.00 | 1.00 |  |  |
| Bbq | 1.00 | 1.00 |  |  |
| Blackberry | 1.00 | 1.00 |  |  |
| Blackberry Bacon Jalapeno | 1.00 | 1.00 |  |  |
| Blue Cheese #0843 | 1.00 | 1.00 |  |  |
| Blue Cheese #ff61 | 1.00 | 1.00 |  |  |
| Bourbon Pulled Pork | 1.00 | 1.00 |  |  |
| Bull Moose 12" | 1.00 | 1.00 |  | 1.00 |
| Caesar | 1.00 | 1.00 |  |  |
| Chocolate Milk | 1.00 | 1.00 |  | 1.00 |
| Coke #1ccc | 1.00 | 1.00 |  |  |
| Croutons | 1.00 | 1.00 |  |  |
| Frost Beer works, little lush - Light IPA | 1.00 | 1.00 |  | 1.00 |
| Gin and Tonic | 1.00 | 1.00 |  | 1.00 |
| Ginger Ale | 1.00 | 1.00 |  | 1.00 |
| Glass #da5c | 1.00 | 1.00 |  |  |
| Glass #e169 | 1.00 | 1.00 |  |  |
| Italian | 1.00 | 1.00 |  |  |
| Josh Cellars - Cabernet Sauvignon | 1.00 | 1.00 |  |  |
| La Marca - Prosecco Split | 1.00 | 1.00 |  |  |
| Lemon | 1.00 | 1.00 |  |  |
| Maker's Mark | 1.00 | 1.00 |  |  |
| Malibu rum | 1.00 | 1.00 |  | 1.00 |
| manhatten | 1.00 | 1.00 |  | 1.00 |
| Milagro | 1.00 | 1.00 |  |  |
| Modelo - Bottle | 1.00 | 1.00 |  | 1.00 |
| Narragansett - Lager Can | 1.00 | 1.00 |  | 1.00 |
| No Basil | 1.00 | 1.00 |  |  |
| no bell peppers | 1.00 | 1.00 |  |  |
| No Blue Cheese Crumbles | 1.00 | 1.00 |  |  |
| No Candied Pecans | 1.00 | 1.00 |  |  |
| no chicken | 1.00 | 1.00 |  |  |
| No goat cheese | 1.00 | 1.00 |  |  |
| No Goat Cheese #d491 | 1.00 | 1.00 |  |  |
| No Hot Honey Drizzle | 1.00 | 1.00 |  |  |
| no mushrooms | 1.00 | 1.00 |  |  |
| No Mushrooms #0af9 | 1.00 | 1.00 |  |  |
| No Peppers #0288 | 1.00 | 1.00 |  |  |
| no pickled veg | 1.00 | 1.00 |  |  |
| No Pulled Pork | 1.00 | 1.00 |  |  |
| No Spicy Aioli | 1.00 | 1.00 |  |  |
| no tomato #b2ee | 1.00 | 1.00 |  |  |
| Oil & Vinager | 1.00 | 1.00 |  |  |
| Old Fashiond | 1.00 | 1.00 |  |  |
| Piggy Apple 12" | 1.00 | 1.00 |  | 1.00 |
| Prosciutto | 1.00 | 1.00 |  |  |
| Ranch #252e | 1.00 | 1.00 |  |  |
| Raspberry White Chocolate Cheesecake | 1.00 | 1.00 |  | 1.00 |
| Rocks | 1.00 | 1.00 |  |  |
| Sam's Cream Soda | 1.00 | 1.00 |  |  |
| Sd Chicken For Salad | 1.00 | 1.00 |  | 1.00 |
| Side House Salad | 1.00 | 1.00 |  | 1.00 |
| Side Smokey Bourbon BBQ | 1.00 | 1.00 |  |  |
| Smokey Bourbon BBQ | 1.00 | 1.00 |  |  |
| Spinach Wrap | 1.00 | 1.00 |  |  |
| Strawberry | 1.00 | 1.00 |  |  |
| Strawberry #ff6f | 1.00 | 1.00 |  |  |
| Sweetened | 1.00 | 1.00 |  |  |
| Tahin Rim | 1.00 | 1.00 |  |  |
| Top Shelf Shot | 1.00 | 1.00 |  | 1.00 |
| Water | 1.00 | 1.00 |  | 1.00 |
| William Hill - Chardonnay | 1.00 | 1.00 |  | 1.00 |
| Hot Tea | 0.00 | 0.00 |  | 2.00 |

- Orders: A 125 (raw table) · B 125 (fresh pull) · C 100 (TRUNCATED at 100 — MCP cap) [live]
- Σ net_sales (A, selection.price non-voided) = $6963.09 · Σ check.amount (B, non-voided) = $6260.74 · Δ $702.35 (differences = check-level discounts/service charges, expected small)
- Items with A≠B: **0** → PASS

