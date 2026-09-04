-- ============================================================================
--  xchef demo seed — Mad Moose Bar & Grill
--  Pure SQL, idempotent (ON CONFLICT / WHERE NOT EXISTS), one DO block so it
--  can run as a single query (Supabase SQL editor / MCP execute_sql / psql -f).
--  Dates are relative to current_date. Safe to re-run.
--
--  The only computed numbers live in invoice_lines.quantity_base_unit and
--  cost_per_base_unit (quantity × units_per_pack × base_units_per_unit and
--  extended_price / quantity_base_unit), exactly what the map job would write.
--
--  After running, these views return rows for the location:
--    on_hand_estimate, count_variance, verification_queue,
--    vendor_price_comparison, vendor_switch_savings, unit_cogs_master, menu_item_cost
-- ============================================================================
do $seed$
declare
  v_tenant      uuid;
  v_location    uuid;
  -- inventory
  v_tequila     uuid;
  v_ketchup     uuid;
  v_tomatoes    uuid;
  v_limes       uuid;
  v_syrup       uuid;
  -- menu
  v_marg        uuid;
  v_burger      uuid;
  v_subpatron   uuid;
  -- vendors
  v_sysco       uuid;
  v_rd          uuid;
  -- mappings
  v_m_sysco_ketchup  uuid;
  v_m_rd_ketchup     uuid;
  v_m_sysco_tomatoes uuid;
  v_m_sysco_tequila  uuid;
  -- invoices
  v_inv1        uuid;
  v_inv2        uuid;
  v_inv3        uuid;
  -- sales loop
  v_i           int;
  v_day         date;
  v_marg_qty    numeric;
  v_burger_qty  numeric;
  v_sub_qty     numeric;
begin
  -- ---------------------------------------------------------------- tenancy
  select id into v_tenant from tenants order by created_at limit 1;
  if v_tenant is null then
    insert into tenants (name) values ('Mad Moose') returning id into v_tenant;
  end if;

  select id into v_location from locations where tenant_id = v_tenant order by created_at limit 1;
  if v_location is null then
    insert into locations (tenant_id, name, timezone, inbound_email_slug)
    values (v_tenant, 'Mad Moose Bar & Grill', 'America/New_York', 'madmoose')
    returning id into v_location;
  end if;

  -- -------------------------------------------------------- inventory items
  insert into inventory_items (tenant_id, name, category, base_unit, pack_to_base_factor, cost_per_base_unit)
  values (v_tenant, 'Tequila - Blanco', 'liquor', 'oz', 25.36, 1.7259)
  on conflict (tenant_id, name) do update
    set category = excluded.category, base_unit = excluded.base_unit,
        pack_to_base_factor = excluded.pack_to_base_factor, cost_per_base_unit = excluded.cost_per_base_unit
  returning id into v_tequila;

  insert into inventory_items (tenant_id, name, category, base_unit, pack_to_base_factor, cost_per_base_unit)
  values (v_tenant, 'Ketchup', 'dry', 'oz', 636, 0.0983)            -- 6 × 106 oz (#10)
  on conflict (tenant_id, name) do update
    set category = excluded.category, base_unit = excluded.base_unit,
        pack_to_base_factor = excluded.pack_to_base_factor, cost_per_base_unit = excluded.cost_per_base_unit
  returning id into v_ketchup;

  insert into inventory_items (tenant_id, name, category, base_unit, pack_to_base_factor, cost_per_base_unit)
  values (v_tenant, 'Tomatoes', 'produce', 'lb', 25, 2.24)          -- was 1.12/lb 40 days ago
  on conflict (tenant_id, name) do update
    set category = excluded.category, base_unit = excluded.base_unit,
        pack_to_base_factor = excluded.pack_to_base_factor, cost_per_base_unit = excluded.cost_per_base_unit
  returning id into v_tomatoes;

  insert into inventory_items (tenant_id, name, category, base_unit, pack_to_base_factor, cost_per_base_unit)
  values (v_tenant, 'Limes', 'produce', 'each', 40, 0.35)
  on conflict (tenant_id, name) do update
    set category = excluded.category, base_unit = excluded.base_unit,
        pack_to_base_factor = excluded.pack_to_base_factor, cost_per_base_unit = excluded.cost_per_base_unit
  returning id into v_limes;

  insert into inventory_items (tenant_id, name, category, base_unit, pack_to_base_factor, cost_per_base_unit)
  values (v_tenant, 'Simple Syrup', 'bar', 'oz', 32, 0.09)
  on conflict (tenant_id, name) do update
    set category = excluded.category, base_unit = excluded.base_unit,
        pack_to_base_factor = excluded.pack_to_base_factor, cost_per_base_unit = excluded.cost_per_base_unit
  returning id into v_syrup;

  -- -------------------------------------------------------------- menu items
  insert into menu_items (tenant_id, toast_menu_item_guid, name, category, price, recipe_status)
  values (v_tenant, 'demo-marg', 'Classic Margarita', 'cocktails', 12.00, 'needs_review')
  on conflict (tenant_id, toast_menu_item_guid) do update
    set name = excluded.name, category = excluded.category, price = excluded.price
  returning id into v_marg;

  insert into menu_items (tenant_id, toast_menu_item_guid, name, category, price, recipe_status)
  values (v_tenant, 'demo-burger', 'Moose Burger', 'entrees', 17.00, 'needs_review')
  on conflict (tenant_id, toast_menu_item_guid) do update
    set name = excluded.name, category = excluded.category, price = excluded.price
  returning id into v_burger;

  insert into menu_items (tenant_id, toast_menu_item_guid, name, category, price, recipe_status)
  values (v_tenant, 'demo-sub-patron', 'Sub Patron', 'modifiers', 3.00, 'draft')
  on conflict (tenant_id, toast_menu_item_guid) do update
    set name = excluded.name, category = excluded.category, price = excluded.price
  returning id into v_subpatron;

  -- ---------------------------------------------------------------- recipes
  insert into recipe_components (menu_item_id, inventory_item_id, quantity, unit, source, confidence, confirmed_at)
  values
    (v_marg,   v_tequila,  1.5, 'oz',   'confirmed', 1.00, now()),
    (v_marg,   v_syrup,    0.5, 'oz',   'ai_draft',  0.70, null),
    (v_marg,   v_limes,    1,   'each', 'confirmed', 1.00, now()),
    (v_burger, v_tomatoes, 0.1, 'lb',   'confirmed', 1.00, now()),
    (v_burger, v_ketchup,  1,   'oz',   'ai_draft',  0.60, null)
  on conflict (menu_item_id, inventory_item_id) do update
    set quantity = excluded.quantity, unit = excluded.unit, source = excluded.source, confidence = excluded.confidence;

  -- ------------------------------------------------- sales, last 14 business dates
  -- Deterministic per day-index so a re-run produces the same rows (ON CONFLICT DO NOTHING).
  for v_i in 1..14 loop
    v_day        := current_date - v_i;
    v_marg_qty   := case when v_i = 3 then 72 else 20 + ((v_i * 7) % 41) end;   -- 72 on the busiest day, 20–60 otherwise
    v_burger_qty := 30 + ((v_i * 5) % 21);                                     -- 30–50
    v_sub_qty    := 5 + (v_i % 6);                                             -- 5–10

    insert into sales_facts (location_id, menu_item_id, toast_menu_item_guid, business_date, quantity_sold, quantity_voided, net_sales)
    values
      (v_location, v_marg,      'demo-marg',       v_day, v_marg_qty,   0, v_marg_qty * 12.00),
      (v_location, v_burger,    'demo-burger',     v_day, v_burger_qty, 0, v_burger_qty * 17.00),
      (v_location, v_subpatron, 'demo-sub-patron', v_day, v_sub_qty,    0, v_sub_qty * 3.00)
    on conflict (location_id, toast_menu_item_guid, business_date) do nothing;
  end loop;

  -- ---------------------------------------------------------------- vendors
  insert into vendors (tenant_id, name, email_domains)
  values (v_tenant, 'Sysco', '{sysco.com}')
  on conflict (tenant_id, name) do update set email_domains = excluded.email_domains
  returning id into v_sysco;

  insert into vendors (tenant_id, name, email_domains)
  values (v_tenant, 'Restaurant Depot', '{restaurantdepot.com}')
  on conflict (tenant_id, name) do update set email_domains = excluded.email_domains
  returning id into v_rd;

  -- --------------------------------------------------------------- mappings
  insert into vendor_item_mappings (tenant_id, vendor_id, vendor_sku, description_norm, inventory_item_id, units_per_pack, base_units_per_unit, pack_description, brand, confirmed_at)
  values (v_tenant, v_sysco, '1234567', 'ketchup 6/#10', v_ketchup, 6, 106, '6/#10', 'Heinz', now())
  on conflict (vendor_id, vendor_sku) do update
    set inventory_item_id = excluded.inventory_item_id, units_per_pack = excluded.units_per_pack,
        base_units_per_unit = excluded.base_units_per_unit, pack_description = excluded.pack_description, brand = excluded.brand
  returning id into v_m_sysco_ketchup;

  insert into vendor_item_mappings (tenant_id, vendor_id, vendor_sku, description_norm, inventory_item_id, units_per_pack, base_units_per_unit, pack_description, brand, confirmed_at)
  values (v_tenant, v_rd, 'RD-8891', 'ketchup 3/114oz', v_ketchup, 3, 114, '3/114OZ', 'Hunt''s', now())
  on conflict (vendor_id, vendor_sku) do update
    set inventory_item_id = excluded.inventory_item_id, units_per_pack = excluded.units_per_pack,
        base_units_per_unit = excluded.base_units_per_unit, pack_description = excluded.pack_description, brand = excluded.brand
  returning id into v_m_rd_ketchup;

  insert into vendor_item_mappings (tenant_id, vendor_id, vendor_sku, description_norm, inventory_item_id, units_per_pack, base_units_per_unit, pack_description, brand, confirmed_at)
  values (v_tenant, v_sysco, '2345678', 'tomatoes 25 lb', v_tomatoes, 1, 25, '25 LB', null, now())
  on conflict (vendor_id, vendor_sku) do update
    set inventory_item_id = excluded.inventory_item_id, units_per_pack = excluded.units_per_pack,
        base_units_per_unit = excluded.base_units_per_unit, pack_description = excluded.pack_description, brand = excluded.brand
  returning id into v_m_sysco_tomatoes;

  insert into vendor_item_mappings (tenant_id, vendor_id, vendor_sku, description_norm, inventory_item_id, units_per_pack, base_units_per_unit, pack_description, brand, confirmed_at)
  values (v_tenant, v_sysco, '3456789', 'tequila blanco 12/750ml', v_tequila, 12, 25.36, '12/750ML', null, now())
  on conflict (vendor_id, vendor_sku) do update
    set inventory_item_id = excluded.inventory_item_id, units_per_pack = excluded.units_per_pack,
        base_units_per_unit = excluded.base_units_per_unit, pack_description = excluded.pack_description, brand = excluded.brand
  returning id into v_m_sysco_tequila;

  -- --------------------------------------------------------------- invoices
  -- content_hash is the idempotency key: unique (location_id, content_hash).
  insert into invoice_documents (location_id, vendor_id, source, status, storage_path, content_hash, invoice_number, invoice_date, received_date, subtotal, tax, total, parse_confidence, posted_at)
  values (v_location, v_sysco, 'manual', 'posted', 'demo/1.json', 'demo-1', 'DEMO-1', current_date - 40, current_date - 40, 597.00, 0, 597.00, 1.00, now())
  on conflict (location_id, content_hash) do update
    set vendor_id = excluded.vendor_id, status = 'posted', invoice_date = excluded.invoice_date, received_date = excluded.received_date,
        subtotal = excluded.subtotal, total = excluded.total, posted_at = coalesce(invoice_documents.posted_at, now())
  returning id into v_inv1;

  insert into invoice_documents (location_id, vendor_id, source, status, storage_path, content_hash, invoice_number, invoice_date, received_date, subtotal, tax, total, parse_confidence, posted_at)
  values (v_location, v_rd, 'manual', 'posted', 'demo/2.json', 'demo-2', 'DEMO-2', current_date - 20, current_date - 20, 201.57, 0, 201.57, 1.00, now())
  on conflict (location_id, content_hash) do update
    set vendor_id = excluded.vendor_id, status = 'posted', invoice_date = excluded.invoice_date, received_date = excluded.received_date,
        subtotal = excluded.subtotal, total = excluded.total, posted_at = coalesce(invoice_documents.posted_at, now())
  returning id into v_inv2;

  insert into invoice_documents (location_id, vendor_id, source, status, storage_path, content_hash, invoice_number, invoice_date, received_date, subtotal, tax, total, parse_confidence, posted_at)
  values (v_location, v_sysco, 'manual', 'posted', 'demo/3.json', 'demo-3', 'DEMO-3', current_date - 5, current_date - 5, 534.50, 0, 534.50, 1.00, now())
  on conflict (location_id, content_hash) do update
    set vendor_id = excluded.vendor_id, status = 'posted', invoice_date = excluded.invoice_date, received_date = excluded.received_date,
        subtotal = excluded.subtotal, total = excluded.total, posted_at = coalesce(invoice_documents.posted_at, now())
  returning id into v_inv3;

  -- Lines. quantity_base_unit = quantity × units_per_pack × base_units_per_unit;
  -- cost_per_base_unit = extended_price / quantity_base_unit (what the map job writes).
  -- Sysco, 40 days ago
  insert into invoice_lines (invoice_id, line_no, vendor_sku, description, pack_size_text, quantity, unit_price, extended_price, status, mapping_id, inventory_item_id, quantity_base_unit, cost_per_base_unit)
  values
    (v_inv1, 1, '1234567', 'KETCHUP 6/#10',           '6/#10',    2, 62.50, 125.00, 'confirmed', v_m_sysco_ketchup,  v_ketchup,  2 * 6 * 106,     125.00 / (2 * 6 * 106)),
    (v_inv1, 2, '2345678', 'TOMATOES 25 LB',          '25 LB',    4, 28.00, 112.00, 'confirmed', v_m_sysco_tomatoes, v_tomatoes, 4 * 1 * 25,      112.00 / (4 * 1 * 25)),
    (v_inv1, 3, '3456789', 'TEQUILA BLANCO 12/750ML', '12/750ML', 1, 360.00, 360.00, 'confirmed', v_m_sysco_tequila, v_tequila,  1 * 12 * 25.36,  360.00 / (1 * 12 * 25.36))
  on conflict (invoice_id, line_no) do update
    set quantity = excluded.quantity, unit_price = excluded.unit_price, extended_price = excluded.extended_price, status = excluded.status,
        mapping_id = excluded.mapping_id, inventory_item_id = excluded.inventory_item_id,
        quantity_base_unit = excluded.quantity_base_unit, cost_per_base_unit = excluded.cost_per_base_unit;

  -- Restaurant Depot, 20 days ago
  insert into invoice_lines (invoice_id, line_no, vendor_sku, description, pack_size_text, quantity, unit_price, extended_price, status, mapping_id, inventory_item_id, quantity_base_unit, cost_per_base_unit)
  values
    (v_inv2, 1, 'RD-8891', 'KETCHUP 3/114OZ', '3/114OZ', 3, 67.19, 201.57, 'confirmed', v_m_rd_ketchup, v_ketchup, 3 * 3 * 114, 201.57 / (3 * 3 * 114))
  on conflict (invoice_id, line_no) do update
    set quantity = excluded.quantity, unit_price = excluded.unit_price, extended_price = excluded.extended_price, status = excluded.status,
        mapping_id = excluded.mapping_id, inventory_item_id = excluded.inventory_item_id,
        quantity_base_unit = excluded.quantity_base_unit, cost_per_base_unit = excluded.cost_per_base_unit;

  -- Sysco, 5 days ago (tomatoes doubled)
  insert into invoice_lines (invoice_id, line_no, vendor_sku, description, pack_size_text, quantity, unit_price, extended_price, status, mapping_id, inventory_item_id, quantity_base_unit, cost_per_base_unit)
  values
    (v_inv3, 1, '2345678', 'TOMATOES 25 LB',          '25 LB',    2, 56.00, 112.00, 'confirmed', v_m_sysco_tomatoes, v_tomatoes, 2 * 1 * 25,     112.00 / (2 * 1 * 25)),
    (v_inv3, 2, '1234567', 'KETCHUP 6/#10',           '6/#10',    1, 62.50,  62.50, 'confirmed', v_m_sysco_ketchup,  v_ketchup,  1 * 6 * 106,    62.50 / (1 * 6 * 106)),
    (v_inv3, 3, '3456789', 'TEQUILA BLANCO 12/750ML', '12/750ML', 1, 360.00, 360.00, 'confirmed', v_m_sysco_tequila, v_tequila,  1 * 12 * 25.36, 360.00 / (1 * 12 * 25.36))
  on conflict (invoice_id, line_no) do update
    set quantity = excluded.quantity, unit_price = excluded.unit_price, extended_price = excluded.extended_price, status = excluded.status,
        mapping_id = excluded.mapping_id, inventory_item_id = excluded.inventory_item_id,
        quantity_base_unit = excluded.quantity_base_unit, cost_per_base_unit = excluded.cost_per_base_unit;

  -- ------------------------------------------------------------ stock counts
  -- Tequila: a ✓ baseline 24 days ago, then a real count 10 days ago (so count_variance has a row).
  insert into stock_counts (location_id, inventory_item_id, count_date, position, counted_at, quantity_base_unit, verification, estimate_at_count)
  values (v_location, v_tequila, current_date - 24, 'close', (current_date - 24)::timestamp + interval '23 hours', 600, 'confirmed_estimate', 600)
  on conflict (location_id, inventory_item_id, count_date, position) do nothing;

  insert into stock_counts (location_id, inventory_item_id, count_date, position, counted_at, quantity_base_unit, verification, estimate_at_count)
  values (v_location, v_tequila, current_date - 10, 'close', (current_date - 10)::timestamp + interval '23 hours', 297.76, 'counted', 300)
  on conflict (location_id, inventory_item_id, count_date, position) do nothing;

  -- Ketchup: a ✓ tap 10 days ago.
  insert into stock_counts (location_id, inventory_item_id, count_date, position, counted_at, quantity_base_unit, verification, estimate_at_count)
  values (v_location, v_ketchup, current_date - 10, 'close', (current_date - 10)::timestamp + interval '23 hours', 1200, 'confirmed_estimate', 1200)
  on conflict (location_id, inventory_item_id, count_date, position) do nothing;

  raise notice 'xchef demo seeded: tenant %, location %', v_tenant, v_location;
end
$seed$;
