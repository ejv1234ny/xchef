# daily_position ↔ on_hand_estimate validation

Gate 1 of KICKOFF-2 Part 1. `pnpm validate:position` takes the latest business
date in `daily_position` and, for every inventory item at the location, checks
that the daily chain's close for that date (expected close, or the counted close
when a close count landed that day) plus any purchases and theoretical usage the
live view already sees after that date equals `on_hand_estimate.on_hand_qty`
within ±0.0001 base units. The daily rows are materialized by
`lib/jobs/dailyPosition.ts` from the same views the estimate reads
(`purchases_by_item`, `usage_by_period`, `stock_counts`), so any drift here is a
bug in the open/close semantics of `lib/core/position.ts`. Sections below are
appended by the script, newest last.

## Business date 2026-09-04

Generated 2026-09-05T15:17:47.021Z · location Mad Moose Bar & Grill · tz America/New_York · tolerance ±0.0001

- Items with a baseline (spec gate): **0 pass / 0 fail** of 0
- All items: **236 pass / 0 fail** of 236
- Result: PASS

| item | unit | baseline | daily close | + after date | live on_hand | Δ | status | restated |
|---|---|:-:|---:|---:|---:|---:|---|---|
| 7 Up (Fountain or Bottle) | oz |  | -48.0000 |  | -48.0000 |  | PASS |  |
| Anchovies (foodservice, fillets, canned or packed in oil) | oz |  | -11.0000 |  | -11.0000 |  | PASS |  |
| Angostura Bitters | oz |  | -18.5000 |  | -18.5000 |  | PASS |  |
| Aperol | oz |  | -8.0000 |  | -8.0000 |  | PASS |  |
| Apple Juice - Bottle | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| Apple Slices | lb |  | -19.2000 |  | -19.2000 |  | PASS |  |
| Arugula | lb |  | -0.9000 |  | -0.9000 |  | PASS |  |
| Athletic Run Wild IPA N/A Beer - Can | each |  | -52.0000 |  | -52.0000 |  | PASS |  |
| Athletic Upside Down NA Beer - Can | each |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Avocado | each |  | -122.2500 |  | -122.2500 |  | PASS |  |
| Bacardi Superior Rum | oz |  | -53.2500 |  | -53.2500 |  | PASS |  |
| Bacon | lb |  | -397.4150 |  | -397.4150 |  | PASS |  |
| Bailey's Original Irish Cream | oz |  | 50.7210 |  | 50.7210 |  | PASS |  |
| Balsamic Glaze | oz |  | -1308.0000 |  | -1308.0000 |  | PASS |  |
| Balsamic Vinegar | oz |  | -697.7500 |  | -697.7500 |  | PASS |  |
| Banana Peppers (sliced, foodservice) | lb |  | -2.9600 |  | -2.9600 |  | PASS |  |
| Barr Hill Gin | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Barr Hill Tom Cat Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Basil Hayden Bourbon | oz |  | -864.8895 |  | -864.8895 |  | PASS |  |
| BBCO, Its Complicated Being a Wizard - Double IPA (Draft) | oz |  | -2268.0000 |  | -2268.0000 |  | PASS |  |
| BBQ Sauce | oz |  | -1106.5000 |  | -1106.5000 |  | PASS |  |
| Beefeater Gin | oz |  | -297.3895 |  | -297.3895 |  | PASS |  |
| Beets | lb |  | -107.0000 |  | -107.0000 |  | PASS |  |
| Bell Peppers | lb |  | -41.1300 |  | -41.1300 |  | PASS |  |
| Black Bean Patty | lb |  | -73.1250 |  | -73.1250 |  | PASS |  |
| Black Flannel German Pilsner (Draft) | oz |  | -5312.0000 |  | -5312.0000 |  | PASS |  |
| Black Olives (sliced or whole, foodservice) | lb |  | -8.2800 |  | -8.2800 |  | PASS |  |
| Black Pepper | oz |  | -10.4500 |  | -10.4500 |  | PASS |  |
| Black Tea Bag | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Blackberry Jam | oz |  | -1028.5000 |  | -1028.5000 |  | PASS |  |
| Blue Cheese Crumbles | oz |  | -2097.0000 |  | -2097.0000 |  | PASS |  |
| Blue Cheese Dressing | oz |  | -438.0000 |  | -438.0000 |  | PASS |  |
| Blueberry Blonde Ale, Rutland beer works (Draft) | oz |  | -1360.0000 |  | -1360.0000 |  | PASS |  |
| Bombay Sapphire Gin | oz |  | -27.0000 |  | -27.0000 |  | PASS |  |
| Bottle #9c27 | each |  | -13.0000 |  | -13.0000 |  | PASS |  |
| Bousquet Reserve Organic Chardonnay | oz |  | -175.0000 |  | -175.0000 |  | PASS |  |
| Brewed Coffee | oz |  | -360.0000 |  | -360.0000 |  | PASS |  |
| Brussel Sprouts | lb |  | -269.9000 |  | -269.9000 |  | PASS |  |
| Bud Light - Bottle | each |  | -303.0000 |  | -303.0000 |  | PASS |  |
| Budweiser - Bottle | each |  | -88.0000 |  | -88.0000 |  | PASS |  |
| Buffalo Trace Bourbon | oz |  | -111.0000 |  | -111.0000 |  | PASS |  |
| Bulleit Bourbon | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Bullet (shot glass pour, unspecified spirit) | oz |  | -16.5000 |  | -16.5000 |  | PASS |  |
| Burger Bun | each |  | -5420.0000 |  | -5420.0000 |  | PASS |  |
| Caesar Dressing | oz |  | -3311.0000 |  | -3311.0000 |  | PASS |  |
| Candied Pecans | oz |  | -214.0000 |  | -214.0000 |  | PASS |  |
| Canned Margarita | each |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Captain Morgan Spiced Rum | oz |  | -133.2500 |  | -133.2500 |  | PASS |  |
| Carrot Cake (slice) | each |  | -75.0000 |  | -75.0000 |  | PASS |  |
| Carrots (shredded) | lb |  | -16.9900 |  | -16.9900 |  | PASS |  |
| Chambord | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Cheddar Cheese | oz |  | -6091.5000 |  | -6091.5000 |  | PASS |  |
| Cheesecake Batter (Eggs, Sugar, Cream, etc.) | oz |  | -311.0000 |  | -311.0000 |  | PASS |  |
| Cheesecake Crust (Graham or Cookie) | oz |  | -148.0000 |  | -148.0000 |  | PASS |  |
| Chicken Tenders (Raw or Pre-breaded) | lb |  | -281.1250 |  | -281.1250 |  | PASS |  |
| Chicken Wings | lb |  | -1186.0000 |  | -1186.0000 |  | PASS |  |
| Chocolate Syrup | oz |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Citizen Cider (Draft) | oz |  | -1872.0000 |  | -1872.0000 |  | PASS |  |
| Club Soda (Fountain or Bottle) | oz |  | -2739.0000 |  | -2739.0000 |  | PASS |  |
| Coke (Fountain or Bottle) | oz |  | -7988.0000 |  | -7988.0000 |  | PASS |  |
| Cold Hollow Extra Dry Cider - Can | each |  | -54.0000 |  | -54.0000 |  | PASS |  |
| Cold Hollow Sparkling Apple Cider - Bottle | each |  | -99.0000 |  | -99.0000 |  | PASS |  |
| Coleslaw | lb |  | -119.9000 |  | -119.9000 |  | PASS |  |
| Cooked Diced Chicken Breast | lb |  | -776.0350 |  | -776.0350 |  | PASS |  |
| Cool Hand Cuke - Gin (Bottle) | each |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Corvezzo - Pinot Grigio | oz |  | -1440.0000 |  | -1440.0000 |  | PASS |  |
| Cranberry Juice | oz |  | -355.0000 |  | -355.0000 |  | PASS |  |
| Cream Cheese | oz |  | -1213.5000 |  | -1213.5000 |  | PASS |  |
| Cream Soda (Fountain or Bottle) | oz |  | -128.0000 |  | -128.0000 |  | PASS |  |
| Croutons | oz |  | -1986.7500 |  | -1986.7500 |  | PASS |  |
| DeKuyper Luscious Peach | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Dewar's White Label Scotch | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Di Majo - Sangiovese | oz |  | -125.0000 |  | -125.0000 |  | PASS |  |
| Di Saronno Amaretto | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Diet Coke (Fountain or Bottle) | oz |  | -6464.0000 |  | -6464.0000 |  | PASS |  |
| Dijon Mustard | oz |  | -96.7500 |  | -96.7500 |  | PASS |  |
| Diplomatico Reserva Exclusiva | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Don Julio Tequila (Blanco or Reposado) | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Downeast Apple Pie (Draft) | oz |  | -4560.0000 |  | -4560.0000 |  | PASS |  |
| Dr. Pepper (Fountain or Bottle) | oz |  | -1808.0000 |  | -1808.0000 |  | PASS |  |
| Dry Vermouth | oz |  | -55.0000 |  | -55.0000 |  | PASS |  |
| Edward - Pale Ale (Draft) | oz |  | -3248.0000 |  | -3248.0000 |  | PASS |  |
| Espolon Tequila Blanco | oz |  | -49.5000 |  | -49.5000 |  | PASS |  |
| Espresso (Freshly Brewed) | oz |  | -256.0000 |  | -256.0000 |  | PASS |  |
| FairLife Chocolate Milk | oz |  | -60.0000 |  | -60.0000 |  | PASS |  |
| Fernland - Sauvignon Blanc | oz |  | -625.0000 |  | -625.0000 |  | PASS |  |
| Fiddlehead - IPA (Draft) | oz |  | -7088.0000 |  | -7088.0000 |  | PASS |  |
| Fig Jam | oz |  | -575.0000 |  | -575.0000 |  | PASS |  |
| Flagship - Cabernet Sauvignon | oz |  | -295.0000 |  | -295.0000 |  | PASS |  |
| Flour Tortilla (Large) | each |  | -1437.0000 |  | -1437.0000 |  | PASS |  |
| French Fries | lb |  | -2548.2500 |  | -2548.2500 |  | PASS |  |
| Fresh Basil | lb |  | -27.3600 |  | -27.3600 |  | PASS |  |
| Fresh Berries | lb |  | -44.8900 |  | -44.8900 |  | PASS |  |
| Frico Frizzante - White Wine | oz |  | -10.0000 |  | -10.0000 |  | PASS |  |
| Frost Beer Works, Little Lush - Light IPA (Draft) | oz |  | -4448.0000 |  | -4448.0000 |  | PASS |  |
| Frying Oil | oz |  | -1475.5000 |  | -1475.5000 |  | PASS |  |
| Garlic Butter | oz |  | -812.0000 |  | -812.0000 |  | PASS |  |
| Ginger Ale (Fountain or Bottle) | oz |  | -2012.0000 |  | -2012.0000 |  | PASS |  |
| Ginger Beer | oz |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Gluten Free Bun | each |  | -126.0000 |  | -126.0000 |  | PASS |  |
| Gluten Free Pizza Crust | each |  | -62.0000 |  | -62.0000 |  | PASS |  |
| Gluten Free Wrap (Tortilla) | each |  | -4.0000 |  | -4.0000 |  | PASS |  |
| Goat Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Good Measure, Riser Ale - Cream Ale (Draft) | oz |  | -3328.0000 |  | -3328.0000 |  | PASS |  |
| Gouda Cheese | oz |  | -611.0000 |  | -611.0000 |  | PASS |  |
| Granulated Sugar | oz |  | -0.1000 |  | -0.1000 |  | PASS |  |
| Grapefruit Soda | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Green Onion | lb |  | -0.2400 |  | -0.2400 |  | PASS |  |
| Grenadine | oz |  | -108.5000 |  | -108.5000 |  | PASS |  |
| Grey Goose Vodka | oz |  | -36.0000 |  | -36.0000 |  | PASS |  |
| Ground Beef | lb |  | -2067.5000 |  | -2067.5000 |  | PASS |  |
| Growers Guild - Pinot Noir | oz |  | -250.0000 |  | -250.0000 |  | PASS |  |
| Ham (diced or sliced, foodservice) | lb |  | -1.2500 |  | -1.2500 |  | PASS |  |
| Hard Boiled Egg | each |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Hendrick's Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Herb Blend | oz |  | -50.7000 |  | -50.7000 |  | PASS |  |
| High Noon - Can | each |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Hornitos Tequila (Blanco or Reposado) | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Hot Honey | oz |  | -28.0000 |  | -28.0000 |  | PASS |  |
| House Dry Rub | oz |  | -47.2500 |  | -47.2500 |  | PASS |  |
| Iced Tea (Housemade or Pre-mix) | oz |  | -5016.0000 |  | -5016.0000 |  | PASS |  |
| Jack Daniel's Tennessee Whiskey | oz |  | -42.0000 |  | -42.0000 |  | PASS |  |
| Jalapenos | lb |  | -29.1700 |  | -29.1700 |  | PASS |  |
| Jameson Irish Whiskey | oz |  | -63.1395 |  | -63.1395 |  | PASS |  |
| Johnnie Walker Black Label Scotch | oz |  | -13.5000 |  | -13.5000 |  | PASS |  |
| Jose Cuervo Especial Gold | oz |  | -214.0290 |  | -214.0290 |  | PASS |  |
| Josh Cellars - Cabernet Sauvignon | oz |  | -130.0000 |  | -130.0000 |  | PASS |  |
| Juice Drink | l |  | 0.0000 |  | 0.0000 |  | PASS |  |
| Ketchup | oz |  | 4523.5000 |  | 4523.5000 |  | PASS |  |
| Ketel One Vodka | oz |  | -1058.1395 |  | -1058.1395 |  | PASS |  |
| Key Lime Pie (slice) | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| La Marca Prosecco Split (187ml) | each |  | -47.0000 |  | -47.0000 |  | PASS |  |
| Lawsons Little Sip - IPA (Draft) | oz |  | -5072.0000 |  | -5072.0000 |  | PASS |  |
| Lemon | each |  | -50.7500 |  | -50.7500 |  | PASS |  |
| Lemon Curd | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Lemon Twist | each |  | -110.0000 |  | -110.0000 |  | PASS |  |
| Lemonade (Housemade or Pre-mix) | oz |  | -9378.0000 |  | -9378.0000 |  | PASS |  |
| Lettuce | lb |  | -326.8700 |  | -326.8700 |  | PASS |  |
| Lime Juice | oz |  | -620.0000 |  | -620.0000 |  | PASS |  |
| Limes | each |  | -181.3500 |  | -181.3500 |  | PASS |  |
| Limoncello | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Long Trail, Long Trail Ale - Amber Ale (Draft) | oz |  | -2304.0000 |  | -2304.0000 |  | PASS |  |
| Maine Lunch - IPA (Draft) | oz |  | -6896.0000 |  | -6896.0000 |  | PASS |  |
| Maker's Mark Bourbon | oz |  | -30.0000 |  | -30.0000 |  | PASS |  |
| Malibu Rum | oz |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Maple Chipotle Sauce | oz |  | -248.0000 |  | -248.0000 |  | PASS |  |
| Maple Mustard Sauce | oz |  | -943.0000 |  | -943.0000 |  | PASS |  |
| Maple Syrup | oz |  | -652.5000 |  | -652.5000 |  | PASS |  |
| Maraschino Cherry | each |  | -257.0000 |  | -257.0000 |  | PASS |  |
| Mascarpone Cheese | oz |  | -20.0000 |  | -20.0000 |  | PASS |  |
| Mayonnaise | oz |  | -383.2500 |  | -383.2500 |  | PASS |  |
| Mezcal | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Midori Melon | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Milagro Tequila (Blanco or Reposado) | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Milk | oz |  | -898.0000 |  | -898.0000 |  | PASS |  |
| Miller Lite (Draft) | oz |  | -3360.0000 |  | -3360.0000 |  | PASS |  |
| Mixed Greens | lb |  | -109.3500 |  | -109.3500 |  | PASS |  |
| Modelo - Bottle | each |  | -101.0000 |  | -101.0000 |  | PASS |  |
| Mozzarella Cheese | oz |  | -40804.0000 |  | -40804.0000 |  | PASS |  |
| Mr. Boston Triple Sec | oz |  | -526.0290 |  | -526.0290 |  | PASS |  |
| Myers's Original Dark Rum | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Narragansett - Lager Can | each |  | -196.0000 |  | -196.0000 |  | PASS |  |
| No Basil Pesto Sauce | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Olive Oil | oz |  | -1603.0000 |  | -1603.0000 |  | PASS |  |
| Onion | lb |  | -179.4700 |  | -179.4700 |  | PASS |  |
| Orange Juice | oz |  | -271.0000 |  | -271.0000 |  | PASS |  |
| Orange Peel | each |  | -15.7000 |  | -15.7000 |  | PASS |  |
| Orgeat Syrup | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Pacifico - Bottle | each |  | -93.0000 |  | -93.0000 |  | PASS |  |
| Parmesan Cheese | oz |  | -1918.0000 |  | -1918.0000 |  | PASS |  |
| Peanut Butter Cake (slice) | each |  | -112.0000 |  | -112.0000 |  | PASS |  |
| Pepperoni | lb |  | -178.8300 |  | -178.8300 |  | PASS |  |
| Pepperoni Slices | lb |  | -38.7500 |  | -38.7500 |  | PASS |  |
| Pickles (sliced, foodservice) | lb |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Pineapple (diced or chunk, foodservice) | lb |  | -23.1500 |  | -23.1500 |  | PASS |  |
| Pizza Dough Ball | each |  | -3549.0000 |  | -3549.0000 |  | PASS |  |
| Pizza Dough Ball (16") | each |  | -2741.0000 |  | -2741.0000 |  | PASS |  |
| Pizza Sauce | oz |  | -28122.5000 |  | -28122.5000 |  | PASS |  |
| Powdered Sugar | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Prosciutto | lb |  | -54.0900 |  | -54.0900 |  | PASS |  |
| Prosecco | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Pulled Pork | lb |  | -33.2500 |  | -33.2500 |  | PASS |  |
| Ranch Dressing | oz |  | -3182.0000 |  | -3182.0000 |  | PASS |  |
| Raspberry Sauce | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| Ricotta Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Roasted Garlic | lb |  | -2.1500 |  | -2.1500 |  | PASS |  |
| Romaine Lettuce | lb |  | -400.2500 |  | -400.2500 |  | PASS |  |
| Root Beer (Fountain or Bottle) | oz |  | -912.0000 |  | -912.0000 |  | PASS |  |
| Salmon Fillet | lb |  | -293.1250 |  | -293.1250 |  | PASS |  |
| Salt | oz |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Salt River/Stoneburn - Sauvignon Blanc | oz |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Sausage | lb |  | -60.2000 |  | -60.2000 |  | PASS |  |
| Sautéed Mushrooms | lb |  | -93.1100 |  | -93.1100 |  | PASS |  |
| Simple Syrup | oz |  | -458.0000 |  | -458.0000 |  | PASS |  |
| Sliced Apples | lb |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Sliced Turkey Breast | lb |  | -59.2500 |  | -59.2500 |  | PASS |  |
| Smirnoff Blueberry Vodka | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Smirnoff Vodka (Well) | oz |  | -71.2500 |  | -71.2500 |  | PASS |  |
| Smoked Brisket | lb |  | -205.8750 |  | -205.8750 |  | PASS |  |
| Soulmates Pre-Prohibition American Lager (Draft) | oz |  | -368.0000 |  | -368.0000 |  | PASS |  |
| Spinach | lb |  | -1.1200 |  | -1.1200 |  | PASS |  |
| Spinach Wrap (Tortilla) | each |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Sprite (Fountain or Bottle) | oz |  | -2140.0000 |  | -2140.0000 |  | PASS |  |
| Stella Artois - Bottle | each |  | -86.0000 |  | -86.0000 |  | PASS |  |
| Strawberry Syrup | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Sugar Packet | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Sweet Potato Fries | lb |  | -355.5000 |  | -355.5000 |  | PASS |  |
| Sweet Vermouth | oz |  | -17.0000 |  | -17.0000 |  | PASS |  |
| Swiss Cheese | oz |  | -432.0000 |  | -432.0000 |  | PASS |  |
| Switchback Ale, Amber Ale (Draft) | oz |  | -4688.0000 |  | -4688.0000 |  | PASS |  |
| T-Thyme - Vodka (Bottle) | each |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Tajin Seasoning | oz |  | -0.0500 |  | -0.0500 |  | PASS |  |
| Tanqueray Gin | oz |  | -53.5000 |  | -53.5000 |  | PASS |  |
| Tequila - Blanco | oz |  | 453.7687 |  | 453.7687 |  | PASS |  |
| Tito's Handmade Vodka | oz |  | -379.6395 |  | -379.6395 |  | PASS |  |
| Tomatoes | lb |  | -245.0700 |  | -245.0700 |  | PASS |  |
| Tonic Water | oz |  | -356.0000 |  | -356.0000 |  | PASS |  |
| Tortilla Chips | oz |  | -822.0000 |  | -822.0000 |  | PASS |  |
| Tullamore Dew Irish Whiskey | oz |  | 23.8605 |  | 23.8605 |  | PASS |  |
| Vermont Blonde Ale - Can | each |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Vermont Ice Coffee Liqueur | oz |  | -205.2790 |  | -205.2790 |  | PASS |  |
| Vermont Seltzer (Draft) | oz |  | -688.0000 |  | -688.0000 |  | PASS |  |
| Vigneti Del Sole - Montepulciano | oz |  | -225.0000 |  | -225.0000 |  | PASS |  |
| Von Trapp, Golden Helles Lager (Draft) | oz |  | -4032.0000 |  | -4032.0000 |  | PASS |  |
| VRAC - Rose' | oz |  | -280.0000 |  | -280.0000 |  | PASS |  |
| Walnuts (chopped) | oz |  | -37.5000 |  | -37.5000 |  | PASS |  |
| Water (Tap or Filtered) | oz |  | -2086.0000 |  | -2086.0000 |  | PASS |  |
| White Bread | each |  | -268.0000 |  | -268.0000 |  | PASS |  |
| White Chocolate | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| William Hill - Chardonnay | oz |  | -610.0000 |  | -610.0000 |  | PASS |  |
| Wine (Glass Pour, unspecified type) | oz |  | -1535.0000 |  | -1535.0000 |  | PASS |  |
| Wine (House Red or White) | oz |  | -1096.0000 |  | -1096.0000 |  | PASS |  |
| Wing Sauce | oz |  | -4240.0000 |  | -4240.0000 |  | PASS |  |
| Zero Gravity Green State Zero (NA) - Can | each |  | -115.0000 |  | -115.0000 |  | PASS |  |
| Zero Gravity, Conehead Haze - Hazy IPA (Draft) | oz |  | -2896.0000 |  | -2896.0000 |  | PASS |  |
| Zero Gravity, Green State light - light lager (Draft) | oz |  | -3856.0000 |  | -3856.0000 |  | PASS |  |

## Business date 2026-09-04

Generated 2026-09-05T15:20:08.026Z · location Mad Moose Bar & Grill · tz America/New_York · tolerance ±0.0001

- Items with a baseline (spec gate): **1 pass / 0 fail** of 1
- All items: **236 pass / 0 fail** of 236
- Result: PASS

| item | unit | baseline | daily close | + after date | live on_hand | Δ | status | restated |
|---|---|:-:|---:|---:|---:|---:|---|---|
| 7 Up (Fountain or Bottle) | oz |  | -48.0000 |  | -48.0000 |  | PASS |  |
| Anchovies (foodservice, fillets, canned or packed in oil) | oz |  | -11.0000 |  | -11.0000 |  | PASS |  |
| Angostura Bitters | oz |  | -18.5000 |  | -18.5000 |  | PASS |  |
| Aperol | oz |  | -8.0000 |  | -8.0000 |  | PASS |  |
| Apple Juice - Bottle | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| Apple Slices | lb |  | -19.2000 |  | -19.2000 |  | PASS |  |
| Arugula | lb |  | -0.9000 |  | -0.9000 |  | PASS |  |
| Athletic Run Wild IPA N/A Beer - Can | each |  | -52.0000 |  | -52.0000 |  | PASS |  |
| Athletic Upside Down NA Beer - Can | each |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Avocado | each |  | -122.2500 |  | -122.2500 |  | PASS |  |
| Bacardi Superior Rum | oz |  | -53.2500 |  | -53.2500 |  | PASS |  |
| Bacon | lb |  | -397.4150 |  | -397.4150 |  | PASS |  |
| Bailey's Original Irish Cream | oz |  | 50.7210 |  | 50.7210 |  | PASS |  |
| Balsamic Glaze | oz |  | -1308.0000 |  | -1308.0000 |  | PASS |  |
| Balsamic Vinegar | oz |  | -697.7500 |  | -697.7500 |  | PASS |  |
| Banana Peppers (sliced, foodservice) | lb |  | -2.9600 |  | -2.9600 |  | PASS |  |
| Barr Hill Gin | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Barr Hill Tom Cat Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Basil Hayden Bourbon | oz |  | -864.8895 |  | -864.8895 |  | PASS |  |
| BBCO, Its Complicated Being a Wizard - Double IPA (Draft) | oz |  | -2268.0000 |  | -2268.0000 |  | PASS |  |
| BBQ Sauce | oz |  | -1106.5000 |  | -1106.5000 |  | PASS |  |
| Beefeater Gin | oz |  | -297.3895 |  | -297.3895 |  | PASS |  |
| Beets | lb |  | -107.0000 |  | -107.0000 |  | PASS |  |
| Bell Peppers | lb |  | -41.1300 |  | -41.1300 |  | PASS |  |
| Black Bean Patty | lb |  | -73.1250 |  | -73.1250 |  | PASS |  |
| Black Flannel German Pilsner (Draft) | oz |  | -5312.0000 |  | -5312.0000 |  | PASS |  |
| Black Olives (sliced or whole, foodservice) | lb |  | -8.2800 |  | -8.2800 |  | PASS |  |
| Black Pepper | oz |  | -10.4500 |  | -10.4500 |  | PASS |  |
| Black Tea Bag | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Blackberry Jam | oz |  | -1028.5000 |  | -1028.5000 |  | PASS |  |
| Blue Cheese Crumbles | oz |  | -2097.0000 |  | -2097.0000 |  | PASS |  |
| Blue Cheese Dressing | oz |  | -438.0000 |  | -438.0000 |  | PASS |  |
| Blueberry Blonde Ale, Rutland beer works (Draft) | oz |  | -1360.0000 |  | -1360.0000 |  | PASS |  |
| Bombay Sapphire Gin | oz |  | -27.0000 |  | -27.0000 |  | PASS |  |
| Bottle #9c27 | each |  | -13.0000 |  | -13.0000 |  | PASS |  |
| Bousquet Reserve Organic Chardonnay | oz |  | -175.0000 |  | -175.0000 |  | PASS |  |
| Brewed Coffee | oz |  | -360.0000 |  | -360.0000 |  | PASS |  |
| Brussel Sprouts | lb |  | -269.9000 |  | -269.9000 |  | PASS |  |
| Bud Light - Bottle | each |  | -303.0000 |  | -303.0000 |  | PASS |  |
| Budweiser - Bottle | each |  | -88.0000 |  | -88.0000 |  | PASS |  |
| Buffalo Trace Bourbon | oz |  | -111.0000 |  | -111.0000 |  | PASS |  |
| Bulleit Bourbon | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Bullet (shot glass pour, unspecified spirit) | oz |  | -16.5000 |  | -16.5000 |  | PASS |  |
| Burger Bun | each |  | -5420.0000 |  | -5420.0000 |  | PASS |  |
| Caesar Dressing | oz |  | -3311.0000 |  | -3311.0000 |  | PASS |  |
| Candied Pecans | oz |  | -214.0000 |  | -214.0000 |  | PASS |  |
| Canned Margarita | each |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Captain Morgan Spiced Rum | oz |  | -133.2500 |  | -133.2500 |  | PASS |  |
| Carrot Cake (slice) | each |  | -75.0000 |  | -75.0000 |  | PASS |  |
| Carrots (shredded) | lb |  | -16.9900 |  | -16.9900 |  | PASS |  |
| Chambord | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Cheddar Cheese | oz |  | -6091.5000 |  | -6091.5000 |  | PASS |  |
| Cheesecake Batter (Eggs, Sugar, Cream, etc.) | oz |  | -311.0000 |  | -311.0000 |  | PASS |  |
| Cheesecake Crust (Graham or Cookie) | oz |  | -148.0000 |  | -148.0000 |  | PASS |  |
| Chicken Tenders (Raw or Pre-breaded) | lb |  | -281.1250 |  | -281.1250 |  | PASS |  |
| Chicken Wings | lb |  | -1186.0000 |  | -1186.0000 |  | PASS |  |
| Chocolate Syrup | oz |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Citizen Cider (Draft) | oz |  | -1872.0000 |  | -1872.0000 |  | PASS |  |
| Club Soda (Fountain or Bottle) | oz |  | -2739.0000 |  | -2739.0000 |  | PASS |  |
| Coke (Fountain or Bottle) | oz |  | -7988.0000 |  | -7988.0000 |  | PASS |  |
| Cold Hollow Extra Dry Cider - Can | each |  | -54.0000 |  | -54.0000 |  | PASS |  |
| Cold Hollow Sparkling Apple Cider - Bottle | each |  | -99.0000 |  | -99.0000 |  | PASS |  |
| Coleslaw | lb |  | -119.9000 |  | -119.9000 |  | PASS |  |
| Cooked Diced Chicken Breast | lb |  | -776.0350 |  | -776.0350 |  | PASS |  |
| Cool Hand Cuke - Gin (Bottle) | each |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Corvezzo - Pinot Grigio | oz |  | -1440.0000 |  | -1440.0000 |  | PASS |  |
| Cranberry Juice | oz |  | -355.0000 |  | -355.0000 |  | PASS |  |
| Cream Cheese | oz |  | -1213.5000 |  | -1213.5000 |  | PASS |  |
| Cream Soda (Fountain or Bottle) | oz |  | -128.0000 |  | -128.0000 |  | PASS |  |
| Croutons | oz |  | -1986.7500 |  | -1986.7500 |  | PASS |  |
| DeKuyper Luscious Peach | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Dewar's White Label Scotch | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Di Majo - Sangiovese | oz |  | -125.0000 |  | -125.0000 |  | PASS |  |
| Di Saronno Amaretto | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Diet Coke (Fountain or Bottle) | oz |  | -6464.0000 |  | -6464.0000 |  | PASS |  |
| Dijon Mustard | oz |  | -96.7500 |  | -96.7500 |  | PASS |  |
| Diplomatico Reserva Exclusiva | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Don Julio Tequila (Blanco or Reposado) | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Downeast Apple Pie (Draft) | oz |  | -4560.0000 |  | -4560.0000 |  | PASS |  |
| Dr. Pepper (Fountain or Bottle) | oz |  | -1808.0000 |  | -1808.0000 |  | PASS |  |
| Dry Vermouth | oz |  | -55.0000 |  | -55.0000 |  | PASS |  |
| Edward - Pale Ale (Draft) | oz |  | -3248.0000 |  | -3248.0000 |  | PASS |  |
| Espolon Tequila Blanco | oz |  | -49.5000 |  | -49.5000 |  | PASS |  |
| Espresso (Freshly Brewed) | oz |  | -256.0000 |  | -256.0000 |  | PASS |  |
| FairLife Chocolate Milk | oz |  | -60.0000 |  | -60.0000 |  | PASS |  |
| Fernland - Sauvignon Blanc | oz |  | -625.0000 |  | -625.0000 |  | PASS |  |
| Fiddlehead - IPA (Draft) | oz |  | -7088.0000 |  | -7088.0000 |  | PASS |  |
| Fig Jam | oz |  | -575.0000 |  | -575.0000 |  | PASS |  |
| Flagship - Cabernet Sauvignon | oz |  | -295.0000 |  | -295.0000 |  | PASS |  |
| Flour Tortilla (Large) | each |  | -1437.0000 |  | -1437.0000 |  | PASS |  |
| French Fries | lb |  | -2548.2500 |  | -2548.2500 |  | PASS |  |
| Fresh Basil | lb |  | -27.3600 |  | -27.3600 |  | PASS |  |
| Fresh Berries | lb |  | -44.8900 |  | -44.8900 |  | PASS |  |
| Frico Frizzante - White Wine | oz |  | -10.0000 |  | -10.0000 |  | PASS |  |
| Frost Beer Works, Little Lush - Light IPA (Draft) | oz |  | -4448.0000 |  | -4448.0000 |  | PASS |  |
| Frying Oil | oz |  | -1475.5000 |  | -1475.5000 |  | PASS |  |
| Garlic Butter | oz |  | -812.0000 |  | -812.0000 |  | PASS |  |
| Ginger Ale (Fountain or Bottle) | oz |  | -2012.0000 |  | -2012.0000 |  | PASS |  |
| Ginger Beer | oz |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Gluten Free Bun | each |  | -126.0000 |  | -126.0000 |  | PASS |  |
| Gluten Free Pizza Crust | each |  | -62.0000 |  | -62.0000 |  | PASS |  |
| Gluten Free Wrap (Tortilla) | each |  | -4.0000 |  | -4.0000 |  | PASS |  |
| Goat Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Good Measure, Riser Ale - Cream Ale (Draft) | oz |  | -3328.0000 |  | -3328.0000 |  | PASS |  |
| Gouda Cheese | oz |  | -611.0000 |  | -611.0000 |  | PASS |  |
| Granulated Sugar | oz |  | -0.1000 |  | -0.1000 |  | PASS |  |
| Grapefruit Soda | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Green Onion | lb |  | -0.2400 |  | -0.2400 |  | PASS |  |
| Grenadine | oz |  | -108.5000 |  | -108.5000 |  | PASS |  |
| Grey Goose Vodka | oz |  | -36.0000 |  | -36.0000 |  | PASS |  |
| Ground Beef | lb |  | -2067.5000 |  | -2067.5000 |  | PASS |  |
| Growers Guild - Pinot Noir | oz |  | -250.0000 |  | -250.0000 |  | PASS |  |
| Ham (diced or sliced, foodservice) | lb |  | -1.2500 |  | -1.2500 |  | PASS |  |
| Hard Boiled Egg | each |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Hendrick's Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Herb Blend | oz |  | -50.7000 |  | -50.7000 |  | PASS |  |
| High Noon - Can | each |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Hornitos Tequila (Blanco or Reposado) | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Hot Honey | oz |  | -28.0000 |  | -28.0000 |  | PASS |  |
| House Dry Rub | oz |  | -47.2500 |  | -47.2500 |  | PASS |  |
| Iced Tea (Housemade or Pre-mix) | oz |  | -5016.0000 |  | -5016.0000 |  | PASS |  |
| Jack Daniel's Tennessee Whiskey | oz |  | -42.0000 |  | -42.0000 |  | PASS |  |
| Jalapenos | lb |  | -29.1700 |  | -29.1700 |  | PASS |  |
| Jameson Irish Whiskey | oz |  | -63.1395 |  | -63.1395 |  | PASS |  |
| Johnnie Walker Black Label Scotch | oz |  | -13.5000 |  | -13.5000 |  | PASS |  |
| Jose Cuervo Especial Gold | oz |  | -214.0290 |  | -214.0290 |  | PASS |  |
| Josh Cellars - Cabernet Sauvignon | oz |  | -130.0000 |  | -130.0000 |  | PASS |  |
| Juice Drink | l |  | 0.0000 |  | 0.0000 |  | PASS |  |
| Ketchup | oz | yes | 5881.5000 |  | 5881.5000 |  | PASS | late_invoice |
| Ketel One Vodka | oz |  | -1058.1395 |  | -1058.1395 |  | PASS |  |
| Key Lime Pie (slice) | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| La Marca Prosecco Split (187ml) | each |  | -47.0000 |  | -47.0000 |  | PASS |  |
| Lawsons Little Sip - IPA (Draft) | oz |  | -5072.0000 |  | -5072.0000 |  | PASS |  |
| Lemon | each |  | -50.7500 |  | -50.7500 |  | PASS |  |
| Lemon Curd | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Lemon Twist | each |  | -110.0000 |  | -110.0000 |  | PASS |  |
| Lemonade (Housemade or Pre-mix) | oz |  | -9378.0000 |  | -9378.0000 |  | PASS |  |
| Lettuce | lb |  | -326.8700 |  | -326.8700 |  | PASS |  |
| Lime Juice | oz |  | -620.0000 |  | -620.0000 |  | PASS |  |
| Limes | each |  | -181.3500 |  | -181.3500 |  | PASS |  |
| Limoncello | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Long Trail, Long Trail Ale - Amber Ale (Draft) | oz |  | -2304.0000 |  | -2304.0000 |  | PASS |  |
| Maine Lunch - IPA (Draft) | oz |  | -6896.0000 |  | -6896.0000 |  | PASS |  |
| Maker's Mark Bourbon | oz |  | -30.0000 |  | -30.0000 |  | PASS |  |
| Malibu Rum | oz |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Maple Chipotle Sauce | oz |  | -248.0000 |  | -248.0000 |  | PASS |  |
| Maple Mustard Sauce | oz |  | -943.0000 |  | -943.0000 |  | PASS |  |
| Maple Syrup | oz |  | -652.5000 |  | -652.5000 |  | PASS |  |
| Maraschino Cherry | each |  | -257.0000 |  | -257.0000 |  | PASS |  |
| Mascarpone Cheese | oz |  | -20.0000 |  | -20.0000 |  | PASS |  |
| Mayonnaise | oz |  | -383.2500 |  | -383.2500 |  | PASS |  |
| Mezcal | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Midori Melon | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Milagro Tequila (Blanco or Reposado) | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Milk | oz |  | -898.0000 |  | -898.0000 |  | PASS |  |
| Miller Lite (Draft) | oz |  | -3360.0000 |  | -3360.0000 |  | PASS |  |
| Mixed Greens | lb |  | -109.3500 |  | -109.3500 |  | PASS |  |
| Modelo - Bottle | each |  | -101.0000 |  | -101.0000 |  | PASS |  |
| Mozzarella Cheese | oz |  | -40804.0000 |  | -40804.0000 |  | PASS |  |
| Mr. Boston Triple Sec | oz |  | -526.0290 |  | -526.0290 |  | PASS |  |
| Myers's Original Dark Rum | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Narragansett - Lager Can | each |  | -196.0000 |  | -196.0000 |  | PASS |  |
| No Basil Pesto Sauce | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Olive Oil | oz |  | -1603.0000 |  | -1603.0000 |  | PASS |  |
| Onion | lb |  | -179.4700 |  | -179.4700 |  | PASS |  |
| Orange Juice | oz |  | -271.0000 |  | -271.0000 |  | PASS |  |
| Orange Peel | each |  | -15.7000 |  | -15.7000 |  | PASS |  |
| Orgeat Syrup | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Pacifico - Bottle | each |  | -93.0000 |  | -93.0000 |  | PASS |  |
| Parmesan Cheese | oz |  | -1918.0000 |  | -1918.0000 |  | PASS |  |
| Peanut Butter Cake (slice) | each |  | -112.0000 |  | -112.0000 |  | PASS |  |
| Pepperoni | lb |  | -178.8300 |  | -178.8300 |  | PASS |  |
| Pepperoni Slices | lb |  | -38.7500 |  | -38.7500 |  | PASS |  |
| Pickles (sliced, foodservice) | lb |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Pineapple (diced or chunk, foodservice) | lb |  | -23.1500 |  | -23.1500 |  | PASS |  |
| Pizza Dough Ball | each |  | -3549.0000 |  | -3549.0000 |  | PASS |  |
| Pizza Dough Ball (16") | each |  | -2741.0000 |  | -2741.0000 |  | PASS |  |
| Pizza Sauce | oz |  | -28122.5000 |  | -28122.5000 |  | PASS |  |
| Powdered Sugar | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Prosciutto | lb |  | -54.0900 |  | -54.0900 |  | PASS |  |
| Prosecco | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Pulled Pork | lb |  | -33.2500 |  | -33.2500 |  | PASS |  |
| Ranch Dressing | oz |  | -3182.0000 |  | -3182.0000 |  | PASS |  |
| Raspberry Sauce | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| Ricotta Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Roasted Garlic | lb |  | -2.1500 |  | -2.1500 |  | PASS |  |
| Romaine Lettuce | lb |  | -400.2500 |  | -400.2500 |  | PASS |  |
| Root Beer (Fountain or Bottle) | oz |  | -912.0000 |  | -912.0000 |  | PASS |  |
| Salmon Fillet | lb |  | -293.1250 |  | -293.1250 |  | PASS |  |
| Salt | oz |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Salt River/Stoneburn - Sauvignon Blanc | oz |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Sausage | lb |  | -60.2000 |  | -60.2000 |  | PASS |  |
| Sautéed Mushrooms | lb |  | -93.1100 |  | -93.1100 |  | PASS |  |
| Simple Syrup | oz |  | -458.0000 |  | -458.0000 |  | PASS |  |
| Sliced Apples | lb |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Sliced Turkey Breast | lb |  | -59.2500 |  | -59.2500 |  | PASS |  |
| Smirnoff Blueberry Vodka | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Smirnoff Vodka (Well) | oz |  | -71.2500 |  | -71.2500 |  | PASS |  |
| Smoked Brisket | lb |  | -205.8750 |  | -205.8750 |  | PASS |  |
| Soulmates Pre-Prohibition American Lager (Draft) | oz |  | -368.0000 |  | -368.0000 |  | PASS |  |
| Spinach | lb |  | -1.1200 |  | -1.1200 |  | PASS |  |
| Spinach Wrap (Tortilla) | each |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Sprite (Fountain or Bottle) | oz |  | -2140.0000 |  | -2140.0000 |  | PASS |  |
| Stella Artois - Bottle | each |  | -86.0000 |  | -86.0000 |  | PASS |  |
| Strawberry Syrup | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Sugar Packet | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Sweet Potato Fries | lb |  | -355.5000 |  | -355.5000 |  | PASS |  |
| Sweet Vermouth | oz |  | -17.0000 |  | -17.0000 |  | PASS |  |
| Swiss Cheese | oz |  | -432.0000 |  | -432.0000 |  | PASS |  |
| Switchback Ale, Amber Ale (Draft) | oz |  | -4688.0000 |  | -4688.0000 |  | PASS |  |
| T-Thyme - Vodka (Bottle) | each |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Tajin Seasoning | oz |  | -0.0500 |  | -0.0500 |  | PASS |  |
| Tanqueray Gin | oz |  | -53.5000 |  | -53.5000 |  | PASS |  |
| Tequila - Blanco | oz |  | 453.7687 |  | 453.7687 |  | PASS |  |
| Tito's Handmade Vodka | oz |  | -379.6395 |  | -379.6395 |  | PASS |  |
| Tomatoes | lb |  | -245.0700 |  | -245.0700 |  | PASS |  |
| Tonic Water | oz |  | -356.0000 |  | -356.0000 |  | PASS |  |
| Tortilla Chips | oz |  | -822.0000 |  | -822.0000 |  | PASS |  |
| Tullamore Dew Irish Whiskey | oz |  | 23.8605 |  | 23.8605 |  | PASS |  |
| Vermont Blonde Ale - Can | each |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Vermont Ice Coffee Liqueur | oz |  | -205.2790 |  | -205.2790 |  | PASS |  |
| Vermont Seltzer (Draft) | oz |  | -688.0000 |  | -688.0000 |  | PASS |  |
| Vigneti Del Sole - Montepulciano | oz |  | -225.0000 |  | -225.0000 |  | PASS |  |
| Von Trapp, Golden Helles Lager (Draft) | oz |  | -4032.0000 |  | -4032.0000 |  | PASS |  |
| VRAC - Rose' | oz |  | -280.0000 |  | -280.0000 |  | PASS |  |
| Walnuts (chopped) | oz |  | -37.5000 |  | -37.5000 |  | PASS |  |
| Water (Tap or Filtered) | oz |  | -2086.0000 |  | -2086.0000 |  | PASS |  |
| White Bread | each |  | -268.0000 |  | -268.0000 |  | PASS |  |
| White Chocolate | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| William Hill - Chardonnay | oz |  | -610.0000 |  | -610.0000 |  | PASS |  |
| Wine (Glass Pour, unspecified type) | oz |  | -1535.0000 |  | -1535.0000 |  | PASS |  |
| Wine (House Red or White) | oz |  | -1096.0000 |  | -1096.0000 |  | PASS |  |
| Wing Sauce | oz |  | -4240.0000 |  | -4240.0000 |  | PASS |  |
| Zero Gravity Green State Zero (NA) - Can | each |  | -115.0000 |  | -115.0000 |  | PASS |  |
| Zero Gravity, Conehead Haze - Hazy IPA (Draft) | oz |  | -2896.0000 |  | -2896.0000 |  | PASS |  |
| Zero Gravity, Green State light - light lager (Draft) | oz |  | -3856.0000 |  | -3856.0000 |  | PASS |  |

## Business date 2026-09-04

Generated 2026-09-05T15:21:23.302Z · location Mad Moose Bar & Grill · tz America/New_York · tolerance ±0.0001

- Items with a baseline (spec gate): **0 pass / 0 fail** of 0
- All items: **236 pass / 0 fail** of 236
- Result: PASS

| item | unit | baseline | daily close | + after date | live on_hand | Δ | status | restated |
|---|---|:-:|---:|---:|---:|---:|---|---|
| 7 Up (Fountain or Bottle) | oz |  | -48.0000 |  | -48.0000 |  | PASS |  |
| Anchovies (foodservice, fillets, canned or packed in oil) | oz |  | -11.0000 |  | -11.0000 |  | PASS |  |
| Angostura Bitters | oz |  | -18.5000 |  | -18.5000 |  | PASS |  |
| Aperol | oz |  | -8.0000 |  | -8.0000 |  | PASS |  |
| Apple Juice - Bottle | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| Apple Slices | lb |  | -19.2000 |  | -19.2000 |  | PASS |  |
| Arugula | lb |  | -0.9000 |  | -0.9000 |  | PASS |  |
| Athletic Run Wild IPA N/A Beer - Can | each |  | -52.0000 |  | -52.0000 |  | PASS |  |
| Athletic Upside Down NA Beer - Can | each |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Avocado | each |  | -122.2500 |  | -122.2500 |  | PASS |  |
| Bacardi Superior Rum | oz |  | -53.2500 |  | -53.2500 |  | PASS |  |
| Bacon | lb |  | -397.4150 | -0.1300 | -397.5450 |  | PASS |  |
| Bailey's Original Irish Cream | oz |  | 50.7210 |  | 50.7210 |  | PASS |  |
| Balsamic Glaze | oz |  | -1308.0000 |  | -1308.0000 |  | PASS |  |
| Balsamic Vinegar | oz |  | -697.7500 |  | -697.7500 |  | PASS |  |
| Banana Peppers (sliced, foodservice) | lb |  | -2.9600 |  | -2.9600 |  | PASS |  |
| Barr Hill Gin | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Barr Hill Tom Cat Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Basil Hayden Bourbon | oz |  | -864.8895 |  | -864.8895 |  | PASS |  |
| BBCO, Its Complicated Being a Wizard - Double IPA (Draft) | oz |  | -2268.0000 |  | -2268.0000 |  | PASS |  |
| BBQ Sauce | oz |  | -1106.5000 |  | -1106.5000 |  | PASS |  |
| Beefeater Gin | oz |  | -297.3895 |  | -297.3895 |  | PASS |  |
| Beets | lb |  | -107.0000 |  | -107.0000 |  | PASS |  |
| Bell Peppers | lb |  | -41.1300 |  | -41.1300 |  | PASS |  |
| Black Bean Patty | lb |  | -73.1250 |  | -73.1250 |  | PASS |  |
| Black Flannel German Pilsner (Draft) | oz |  | -5312.0000 |  | -5312.0000 |  | PASS |  |
| Black Olives (sliced or whole, foodservice) | lb |  | -8.2800 |  | -8.2800 |  | PASS |  |
| Black Pepper | oz |  | -10.4500 |  | -10.4500 |  | PASS |  |
| Black Tea Bag | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Blackberry Jam | oz |  | -1028.5000 |  | -1028.5000 |  | PASS |  |
| Blue Cheese Crumbles | oz |  | -2097.0000 |  | -2097.0000 |  | PASS |  |
| Blue Cheese Dressing | oz |  | -438.0000 |  | -438.0000 |  | PASS |  |
| Blueberry Blonde Ale, Rutland beer works (Draft) | oz |  | -1360.0000 |  | -1360.0000 |  | PASS |  |
| Bombay Sapphire Gin | oz |  | -27.0000 |  | -27.0000 |  | PASS |  |
| Bottle #9c27 | each |  | -13.0000 |  | -13.0000 |  | PASS |  |
| Bousquet Reserve Organic Chardonnay | oz |  | -175.0000 |  | -175.0000 |  | PASS |  |
| Brewed Coffee | oz |  | -360.0000 |  | -360.0000 |  | PASS |  |
| Brussel Sprouts | lb |  | -269.9000 |  | -269.9000 |  | PASS |  |
| Bud Light - Bottle | each |  | -303.0000 |  | -303.0000 |  | PASS |  |
| Budweiser - Bottle | each |  | -88.0000 |  | -88.0000 |  | PASS |  |
| Buffalo Trace Bourbon | oz |  | -111.0000 |  | -111.0000 |  | PASS |  |
| Bulleit Bourbon | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Bullet (shot glass pour, unspecified spirit) | oz |  | -16.5000 |  | -16.5000 |  | PASS |  |
| Burger Bun | each |  | -5420.0000 |  | -5420.0000 |  | PASS |  |
| Caesar Dressing | oz |  | -3311.0000 |  | -3311.0000 |  | PASS |  |
| Candied Pecans | oz |  | -214.0000 |  | -214.0000 |  | PASS |  |
| Canned Margarita | each |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Captain Morgan Spiced Rum | oz |  | -133.2500 |  | -133.2500 |  | PASS |  |
| Carrot Cake (slice) | each |  | -75.0000 |  | -75.0000 |  | PASS |  |
| Carrots (shredded) | lb |  | -16.9900 |  | -16.9900 |  | PASS |  |
| Chambord | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Cheddar Cheese | oz |  | -6091.5000 |  | -6091.5000 |  | PASS |  |
| Cheesecake Batter (Eggs, Sugar, Cream, etc.) | oz |  | -311.0000 |  | -311.0000 |  | PASS |  |
| Cheesecake Crust (Graham or Cookie) | oz |  | -148.0000 |  | -148.0000 |  | PASS |  |
| Chicken Tenders (Raw or Pre-breaded) | lb |  | -281.1250 |  | -281.1250 |  | PASS |  |
| Chicken Wings | lb |  | -1186.0000 |  | -1186.0000 |  | PASS |  |
| Chocolate Syrup | oz |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Citizen Cider (Draft) | oz |  | -1872.0000 |  | -1872.0000 |  | PASS |  |
| Club Soda (Fountain or Bottle) | oz |  | -2739.0000 |  | -2739.0000 |  | PASS |  |
| Coke (Fountain or Bottle) | oz |  | -7988.0000 |  | -7988.0000 |  | PASS |  |
| Cold Hollow Extra Dry Cider - Can | each |  | -54.0000 |  | -54.0000 |  | PASS |  |
| Cold Hollow Sparkling Apple Cider - Bottle | each |  | -99.0000 |  | -99.0000 |  | PASS |  |
| Coleslaw | lb |  | -119.9000 |  | -119.9000 |  | PASS |  |
| Cooked Diced Chicken Breast | lb |  | -776.0350 |  | -776.0350 |  | PASS |  |
| Cool Hand Cuke - Gin (Bottle) | each |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Corvezzo - Pinot Grigio | oz |  | -1440.0000 |  | -1440.0000 |  | PASS |  |
| Cranberry Juice | oz |  | -355.0000 |  | -355.0000 |  | PASS |  |
| Cream Cheese | oz |  | -1213.5000 |  | -1213.5000 |  | PASS |  |
| Cream Soda (Fountain or Bottle) | oz |  | -128.0000 |  | -128.0000 |  | PASS |  |
| Croutons | oz |  | -1986.7500 |  | -1986.7500 |  | PASS |  |
| DeKuyper Luscious Peach | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Dewar's White Label Scotch | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Di Majo - Sangiovese | oz |  | -125.0000 |  | -125.0000 |  | PASS |  |
| Di Saronno Amaretto | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Diet Coke (Fountain or Bottle) | oz |  | -6464.0000 |  | -6464.0000 |  | PASS |  |
| Dijon Mustard | oz |  | -96.7500 |  | -96.7500 |  | PASS |  |
| Diplomatico Reserva Exclusiva | oz |  | 17.8605 |  | 17.8605 |  | PASS |  |
| Don Julio Tequila (Blanco or Reposado) | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Downeast Apple Pie (Draft) | oz |  | -4560.0000 |  | -4560.0000 |  | PASS |  |
| Dr. Pepper (Fountain or Bottle) | oz |  | -1808.0000 |  | -1808.0000 |  | PASS |  |
| Dry Vermouth | oz |  | -55.0000 |  | -55.0000 |  | PASS |  |
| Edward - Pale Ale (Draft) | oz |  | -3248.0000 |  | -3248.0000 |  | PASS |  |
| Espolon Tequila Blanco | oz |  | -49.5000 |  | -49.5000 |  | PASS |  |
| Espresso (Freshly Brewed) | oz |  | -256.0000 |  | -256.0000 |  | PASS |  |
| FairLife Chocolate Milk | oz |  | -60.0000 |  | -60.0000 |  | PASS |  |
| Fernland - Sauvignon Blanc | oz |  | -625.0000 |  | -625.0000 |  | PASS |  |
| Fiddlehead - IPA (Draft) | oz |  | -7088.0000 |  | -7088.0000 |  | PASS |  |
| Fig Jam | oz |  | -575.0000 |  | -575.0000 |  | PASS |  |
| Flagship - Cabernet Sauvignon | oz |  | -295.0000 |  | -295.0000 |  | PASS |  |
| Flour Tortilla (Large) | each |  | -1437.0000 |  | -1437.0000 |  | PASS |  |
| French Fries | lb |  | -2548.2500 |  | -2548.2500 |  | PASS |  |
| Fresh Basil | lb |  | -27.3600 | -0.0300 | -27.3900 |  | PASS |  |
| Fresh Berries | lb |  | -44.8900 |  | -44.8900 |  | PASS |  |
| Frico Frizzante - White Wine | oz |  | -10.0000 |  | -10.0000 |  | PASS |  |
| Frost Beer Works, Little Lush - Light IPA (Draft) | oz |  | -4448.0000 |  | -4448.0000 |  | PASS |  |
| Frying Oil | oz |  | -1475.5000 |  | -1475.5000 |  | PASS |  |
| Garlic Butter | oz |  | -812.0000 |  | -812.0000 |  | PASS |  |
| Ginger Ale (Fountain or Bottle) | oz |  | -2012.0000 |  | -2012.0000 |  | PASS |  |
| Ginger Beer | oz |  | -40.0000 |  | -40.0000 |  | PASS |  |
| Gluten Free Bun | each |  | -126.0000 |  | -126.0000 |  | PASS |  |
| Gluten Free Pizza Crust | each |  | -62.0000 |  | -62.0000 |  | PASS |  |
| Gluten Free Wrap (Tortilla) | each |  | -4.0000 |  | -4.0000 |  | PASS |  |
| Goat Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Good Measure, Riser Ale - Cream Ale (Draft) | oz |  | -3328.0000 |  | -3328.0000 |  | PASS |  |
| Gouda Cheese | oz |  | -611.0000 |  | -611.0000 |  | PASS |  |
| Granulated Sugar | oz |  | -0.1000 |  | -0.1000 |  | PASS |  |
| Grapefruit Soda | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Green Onion | lb |  | -0.2400 |  | -0.2400 |  | PASS |  |
| Grenadine | oz |  | -108.5000 |  | -108.5000 |  | PASS |  |
| Grey Goose Vodka | oz |  | -36.0000 |  | -36.0000 |  | PASS |  |
| Ground Beef | lb |  | -2067.5000 |  | -2067.5000 |  | PASS |  |
| Growers Guild - Pinot Noir | oz |  | -250.0000 |  | -250.0000 |  | PASS |  |
| Ham (diced or sliced, foodservice) | lb |  | -1.2500 |  | -1.2500 |  | PASS |  |
| Hard Boiled Egg | each |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Hendrick's Gin | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Herb Blend | oz |  | -50.7000 |  | -50.7000 |  | PASS |  |
| High Noon - Can | each |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Hornitos Tequila (Blanco or Reposado) | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Hot Honey | oz |  | -28.0000 |  | -28.0000 |  | PASS |  |
| House Dry Rub | oz |  | -47.2500 |  | -47.2500 |  | PASS |  |
| Iced Tea (Housemade or Pre-mix) | oz |  | -5016.0000 |  | -5016.0000 |  | PASS |  |
| Jack Daniel's Tennessee Whiskey | oz |  | -42.0000 |  | -42.0000 |  | PASS |  |
| Jalapenos | lb |  | -29.1700 |  | -29.1700 |  | PASS |  |
| Jameson Irish Whiskey | oz |  | -63.1395 |  | -63.1395 |  | PASS |  |
| Johnnie Walker Black Label Scotch | oz |  | -13.5000 |  | -13.5000 |  | PASS |  |
| Jose Cuervo Especial Gold | oz |  | -214.0290 |  | -214.0290 |  | PASS |  |
| Josh Cellars - Cabernet Sauvignon | oz |  | -130.0000 |  | -130.0000 |  | PASS |  |
| Juice Drink | l |  | 0.0000 |  | 0.0000 |  | PASS |  |
| Ketchup | oz |  | 4523.5000 |  | 4523.5000 |  | PASS |  |
| Ketel One Vodka | oz |  | -1058.1395 |  | -1058.1395 |  | PASS |  |
| Key Lime Pie (slice) | each |  | -51.0000 |  | -51.0000 |  | PASS |  |
| La Marca Prosecco Split (187ml) | each |  | -47.0000 |  | -47.0000 |  | PASS |  |
| Lawsons Little Sip - IPA (Draft) | oz |  | -5072.0000 |  | -5072.0000 |  | PASS |  |
| Lemon | each |  | -50.7500 |  | -50.7500 |  | PASS |  |
| Lemon Curd | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Lemon Twist | each |  | -110.0000 |  | -110.0000 |  | PASS |  |
| Lemonade (Housemade or Pre-mix) | oz |  | -9378.0000 |  | -9378.0000 |  | PASS |  |
| Lettuce | lb |  | -326.8700 |  | -326.8700 |  | PASS |  |
| Lime Juice | oz |  | -620.0000 |  | -620.0000 |  | PASS |  |
| Limes | each |  | -181.3500 |  | -181.3500 |  | PASS |  |
| Limoncello | oz |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Long Trail, Long Trail Ale - Amber Ale (Draft) | oz |  | -2304.0000 |  | -2304.0000 |  | PASS |  |
| Maine Lunch - IPA (Draft) | oz |  | -6896.0000 |  | -6896.0000 |  | PASS |  |
| Maker's Mark Bourbon | oz |  | -30.0000 |  | -30.0000 |  | PASS |  |
| Malibu Rum | oz |  | -9.0000 |  | -9.0000 |  | PASS |  |
| Maple Chipotle Sauce | oz |  | -248.0000 |  | -248.0000 |  | PASS |  |
| Maple Mustard Sauce | oz |  | -943.0000 |  | -943.0000 |  | PASS |  |
| Maple Syrup | oz |  | -652.5000 |  | -652.5000 |  | PASS |  |
| Maraschino Cherry | each |  | -257.0000 |  | -257.0000 |  | PASS |  |
| Mascarpone Cheese | oz |  | -20.0000 |  | -20.0000 |  | PASS |  |
| Mayonnaise | oz |  | -383.2500 |  | -383.2500 |  | PASS |  |
| Mezcal | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Midori Melon | oz |  | 25.3605 |  | 25.3605 |  | PASS |  |
| Milagro Tequila (Blanco or Reposado) | oz |  | -24.0000 |  | -24.0000 |  | PASS |  |
| Milk | oz |  | -898.0000 |  | -898.0000 |  | PASS |  |
| Miller Lite (Draft) | oz |  | -3360.0000 |  | -3360.0000 |  | PASS |  |
| Mixed Greens | lb |  | -109.3500 |  | -109.3500 |  | PASS |  |
| Modelo - Bottle | each |  | -101.0000 |  | -101.0000 |  | PASS |  |
| Mozzarella Cheese | oz |  | -40804.0000 | -12.0000 | -40816.0000 |  | PASS |  |
| Mr. Boston Triple Sec | oz |  | -526.0290 |  | -526.0290 |  | PASS |  |
| Myers's Original Dark Rum | oz |  | -4.5000 |  | -4.5000 |  | PASS |  |
| Narragansett - Lager Can | each |  | -196.0000 |  | -196.0000 |  | PASS |  |
| No Basil Pesto Sauce | oz |  | -3.0000 |  | -3.0000 |  | PASS |  |
| Olive Oil | oz |  | -1603.0000 | -0.5000 | -1603.5000 |  | PASS |  |
| Onion | lb |  | -179.4700 |  | -179.4700 |  | PASS |  |
| Orange Juice | oz |  | -271.0000 |  | -271.0000 |  | PASS |  |
| Orange Peel | each |  | -15.7000 |  | -15.7000 |  | PASS |  |
| Orgeat Syrup | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Pacifico - Bottle | each |  | -93.0000 |  | -93.0000 |  | PASS |  |
| Parmesan Cheese | oz |  | -1918.0000 |  | -1918.0000 |  | PASS |  |
| Peanut Butter Cake (slice) | each |  | -112.0000 |  | -112.0000 |  | PASS |  |
| Pepperoni | lb |  | -178.8300 |  | -178.8300 |  | PASS |  |
| Pepperoni Slices | lb |  | -38.7500 |  | -38.7500 |  | PASS |  |
| Pickles (sliced, foodservice) | lb |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Pineapple (diced or chunk, foodservice) | lb |  | -23.1500 |  | -23.1500 |  | PASS |  |
| Pizza Dough Ball | each |  | -3549.0000 | -2.0000 | -3551.0000 |  | PASS |  |
| Pizza Dough Ball (16") | each |  | -2741.0000 |  | -2741.0000 |  | PASS |  |
| Pizza Sauce | oz |  | -28122.5000 | -8.0000 | -28130.5000 |  | PASS |  |
| Powdered Sugar | oz |  | -2.0000 |  | -2.0000 |  | PASS |  |
| Prosciutto | lb |  | -54.0900 |  | -54.0900 |  | PASS |  |
| Prosecco | oz |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Pulled Pork | lb |  | -33.2500 |  | -33.2500 |  | PASS |  |
| Ranch Dressing | oz |  | -3182.0000 |  | -3182.0000 |  | PASS |  |
| Raspberry Sauce | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| Ricotta Cheese | oz |  | -6.0000 |  | -6.0000 |  | PASS |  |
| Roasted Garlic | lb |  | -2.1500 |  | -2.1500 |  | PASS |  |
| Romaine Lettuce | lb |  | -400.2500 |  | -400.2500 |  | PASS |  |
| Root Beer (Fountain or Bottle) | oz |  | -912.0000 |  | -912.0000 |  | PASS |  |
| Salmon Fillet | lb |  | -293.1250 |  | -293.1250 |  | PASS |  |
| Salt | oz |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Salt River/Stoneburn - Sauvignon Blanc | oz |  | -15.0000 |  | -15.0000 |  | PASS |  |
| Sausage | lb |  | -60.2000 |  | -60.2000 |  | PASS |  |
| Sautéed Mushrooms | lb |  | -93.1100 |  | -93.1100 |  | PASS |  |
| Simple Syrup | oz |  | -458.0000 |  | -458.0000 |  | PASS |  |
| Sliced Apples | lb |  | -14.5500 |  | -14.5500 |  | PASS |  |
| Sliced Turkey Breast | lb |  | -59.2500 |  | -59.2500 |  | PASS |  |
| Smirnoff Blueberry Vodka | oz |  | -1.5000 |  | -1.5000 |  | PASS |  |
| Smirnoff Vodka (Well) | oz |  | -71.2500 |  | -71.2500 |  | PASS |  |
| Smoked Brisket | lb |  | -205.8750 |  | -205.8750 |  | PASS |  |
| Soulmates Pre-Prohibition American Lager (Draft) | oz |  | -368.0000 |  | -368.0000 |  | PASS |  |
| Spinach | lb |  | -1.1200 |  | -1.1200 |  | PASS |  |
| Spinach Wrap (Tortilla) | each |  | -63.0000 |  | -63.0000 |  | PASS |  |
| Sprite (Fountain or Bottle) | oz |  | -2140.0000 |  | -2140.0000 |  | PASS |  |
| Stella Artois - Bottle | each |  | -86.0000 |  | -86.0000 |  | PASS |  |
| Strawberry Syrup | oz |  | -21.0000 |  | -21.0000 |  | PASS |  |
| Sugar Packet | each |  | -18.0000 |  | -18.0000 |  | PASS |  |
| Sweet Potato Fries | lb |  | -355.5000 |  | -355.5000 |  | PASS |  |
| Sweet Vermouth | oz |  | -17.0000 |  | -17.0000 |  | PASS |  |
| Swiss Cheese | oz |  | -432.0000 |  | -432.0000 |  | PASS |  |
| Switchback Ale, Amber Ale (Draft) | oz |  | -4688.0000 |  | -4688.0000 |  | PASS |  |
| T-Thyme - Vodka (Bottle) | each |  | -5.0000 |  | -5.0000 |  | PASS |  |
| Tajin Seasoning | oz |  | -0.0500 |  | -0.0500 |  | PASS |  |
| Tanqueray Gin | oz |  | -53.5000 |  | -53.5000 |  | PASS |  |
| Tequila - Blanco | oz |  | 453.7687 |  | 453.7687 |  | PASS |  |
| Tito's Handmade Vodka | oz |  | -379.6395 |  | -379.6395 |  | PASS |  |
| Tomatoes | lb |  | -245.0700 | -0.1500 | -245.2200 |  | PASS |  |
| Tonic Water | oz |  | -356.0000 |  | -356.0000 |  | PASS |  |
| Tortilla Chips | oz |  | -822.0000 |  | -822.0000 |  | PASS |  |
| Tullamore Dew Irish Whiskey | oz |  | 23.8605 |  | 23.8605 |  | PASS |  |
| Vermont Blonde Ale - Can | each |  | -12.0000 |  | -12.0000 |  | PASS |  |
| Vermont Ice Coffee Liqueur | oz |  | -205.2790 |  | -205.2790 |  | PASS |  |
| Vermont Seltzer (Draft) | oz |  | -688.0000 |  | -688.0000 |  | PASS |  |
| Vigneti Del Sole - Montepulciano | oz |  | -225.0000 |  | -225.0000 |  | PASS |  |
| Von Trapp, Golden Helles Lager (Draft) | oz |  | -4032.0000 |  | -4032.0000 |  | PASS |  |
| VRAC - Rose' | oz |  | -280.0000 |  | -280.0000 |  | PASS |  |
| Walnuts (chopped) | oz |  | -37.5000 |  | -37.5000 |  | PASS |  |
| Water (Tap or Filtered) | oz |  | -2086.0000 |  | -2086.0000 |  | PASS |  |
| White Bread | each |  | -268.0000 |  | -268.0000 |  | PASS |  |
| White Chocolate | oz |  | -97.0000 |  | -97.0000 |  | PASS |  |
| William Hill - Chardonnay | oz |  | -610.0000 |  | -610.0000 |  | PASS |  |
| Wine (Glass Pour, unspecified type) | oz |  | -1535.0000 |  | -1535.0000 |  | PASS |  |
| Wine (House Red or White) | oz |  | -1096.0000 |  | -1096.0000 |  | PASS |  |
| Wing Sauce | oz |  | -4240.0000 |  | -4240.0000 |  | PASS |  |
| Zero Gravity Green State Zero (NA) - Can | each |  | -115.0000 |  | -115.0000 |  | PASS |  |
| Zero Gravity, Conehead Haze - Hazy IPA (Draft) | oz |  | -2896.0000 |  | -2896.0000 |  | PASS |  |
| Zero Gravity, Green State light - light lager (Draft) | oz |  | -3856.0000 |  | -3856.0000 |  | PASS |  |

