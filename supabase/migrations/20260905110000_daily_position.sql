-- 0011: daily_position — the discrepancy as a daily record, restated (never
-- erased) when a late invoice posts, sales are rebuilt, a count is backdated or
-- a recipe changes. One row per (location, ingredient, business date).
create table daily_position (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id) on delete cascade,
  inventory_item_id     uuid not null references inventory_items(id) on delete cascade,
  business_date         date not null,
  opening_qty           numeric(14,4) not null default 0,
  received_qty          numeric(14,4) not null default 0,
  theoretical_used_qty  numeric(14,4) not null default 0,
  expected_close_qty    numeric(14,4) not null default 0,
  counted_qty           numeric(14,4),
  variance_qty          numeric(14,4),
  variance_value        numeric(14,4),
  cost_per_base_unit    numeric(14,4),
  verification          text not null default 'none' check (verification in ('none','confirmed_estimate','counted')),
  last_verified_at      timestamptz,
  included_invoice_ids  uuid[] not null default '{}',
  included_count_id     uuid,
  computed_at           timestamptz not null default now(),
  restated_at           timestamptz,
  restatement_reason    text check (restatement_reason in ('late_invoice','sales_rebuild','count_backdated','recipe_change','manual')),
  unique (location_id, inventory_item_id, business_date)
);
create index on daily_position (location_id, business_date desc);
create index on daily_position (inventory_item_id, business_date desc);

alter table daily_position enable row level security;
create policy location_isolation on daily_position for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));
