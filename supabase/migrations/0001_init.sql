-- ============================================================================
--  xchef — Usage-Tracking Schema (Supabase / Postgres)
--  Applied to xchef-dev (gqahyzoebifscqcrrkgq) on 2026-09-04 via Supabase MCP.
--  Annotated version with rationale: docs/schema.sql
-- ============================================================================

create extension if not exists "pgcrypto";

create type uom as enum ('oz','ml','l','g','kg','lb','each','case','bottle','can');
create type recipe_source as enum ('ai_draft','reverse_engineered','confirmed');
create type recipe_status as enum ('draft','needs_review','confirmed');
create type invoice_status as enum ('received','parsing','needs_review','posted','rejected');
create type invoice_line_status as enum ('unmapped','auto_mapped','confirmed','ignored');
create type verification_type as enum ('confirmed_estimate','counted');
create type count_position as enum ('open','close');
create type invoice_source as enum ('email','forward','upload','paste','manual','api');

-- TENANCY
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table locations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  name                 text not null,
  toast_location_guid  text unique,
  timezone             text not null default 'America/New_York',
  created_at           timestamptz not null default now()
);
create index on locations (tenant_id);

create table memberships (
  user_id     uuid not null,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

create table toast_credentials (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null references locations(id) on delete cascade,
  client_id                text not null,
  client_secret_encrypted  text not null,
  last_synced_at           timestamptz,
  created_at               timestamptz not null default now(),
  unique (location_id)
);

-- CATALOGS
create table inventory_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  name                  text not null,
  category              text,
  base_unit             uom  not null,
  pack_to_base_factor   numeric(12,4),
  cost_per_base_unit    numeric(12,4),
  created_at            timestamptz not null default now(),
  unique (tenant_id, name)
);
create index on inventory_items (tenant_id);

create table menu_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  toast_menu_item_guid  text,
  name                  text not null,
  category              text,
  price                 numeric(12,2),
  recipe_status         recipe_status not null default 'draft',
  created_at            timestamptz not null default now(),
  unique (tenant_id, toast_menu_item_guid),
  unique (tenant_id, name)
);
create index on menu_items (tenant_id);

-- RECIPES
create table recipe_components (
  id                 uuid primary key default gen_random_uuid(),
  menu_item_id       uuid not null references menu_items(id) on delete cascade,
  inventory_item_id  uuid not null references inventory_items(id) on delete restrict,
  quantity           numeric(12,4) not null,
  unit               uom  not null,
  source             recipe_source not null default 'ai_draft',
  confidence         numeric(3,2),
  confirmed_by       uuid,
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  unique (menu_item_id, inventory_item_id)
);
create index on recipe_components (menu_item_id);
create index on recipe_components (inventory_item_id);

-- SALES (Toast Orders API ordersBulk → raw → per-item per-business-day rollup)
create table toast_orders_raw (
  order_guid      text not null,
  location_id     uuid not null references locations(id) on delete cascade,
  business_date   date not null,
  modified_date   timestamptz not null,
  voided          boolean not null default false,
  payload         jsonb not null,
  synced_at       timestamptz not null default now(),
  primary key (location_id, order_guid)
);
create index on toast_orders_raw (location_id, business_date);
create index on toast_orders_raw (location_id, modified_date);

create table sales_facts (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id) on delete cascade,
  menu_item_id          uuid references menu_items(id) on delete set null,
  toast_menu_item_guid  text,
  business_date         date not null,
  quantity_sold         numeric(12,2) not null,
  quantity_voided       numeric(12,2) not null default 0,
  net_sales             numeric(12,2),
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (location_id, toast_menu_item_guid, business_date)
);
create index on sales_facts (location_id, business_date);
create index on sales_facts (menu_item_id);

-- RECEIVING
alter table locations add column inbound_email_slug text unique;

create table vendors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  email_domains text[] default '{}',
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
create index on vendors (tenant_id);

create table invoice_documents (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references locations(id) on delete cascade,
  vendor_id        uuid references vendors(id) on delete set null,
  source           invoice_source not null default 'email',
  status           invoice_status not null default 'received',
  storage_path     text not null,
  email_from       text,
  email_subject    text,
  email_message_id text,
  content_hash     text,
  invoice_number   text,
  invoice_date     date,
  received_date    date,
  subtotal         numeric(12,2),
  tax              numeric(12,2),
  total            numeric(12,2),
  parse_confidence numeric(3,2),
  raw_extraction   jsonb,
  parse_error      text,
  posted_at        timestamptz,
  created_at       timestamptz not null default now(),
  unique (location_id, content_hash)
);
create index on invoice_documents (location_id, status);
create index on invoice_documents (vendor_id, invoice_number);

create table vendor_item_mappings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  vendor_id            uuid not null references vendors(id) on delete cascade,
  vendor_sku           text,
  description_norm     text not null,
  inventory_item_id    uuid not null references inventory_items(id) on delete cascade,
  units_per_pack       numeric(12,4) not null default 1,
  base_units_per_unit  numeric(12,4) not null,
  pack_description     text,
  brand                text,
  confirmed_by         uuid,
  confirmed_at         timestamptz,
  created_at           timestamptz not null default now(),
  unique (vendor_id, vendor_sku),
  unique (vendor_id, description_norm)
);
create index on vendor_item_mappings (tenant_id);
create index on vendor_item_mappings (inventory_item_id);

create table invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references invoice_documents(id) on delete cascade,
  line_no             int  not null,
  vendor_sku          text,
  description         text not null,
  pack_size_text      text,
  quantity            numeric(12,4) not null,
  unit_price          numeric(12,4),
  extended_price      numeric(12,2),
  ai_category_guess   text,
  ai_confidence       numeric(3,2),
  status              invoice_line_status not null default 'unmapped',
  mapping_id          uuid references vendor_item_mappings(id) on delete set null,
  inventory_item_id   uuid references inventory_items(id) on delete set null,
  quantity_base_unit  numeric(14,4),
  cost_per_base_unit  numeric(12,6),
  created_at          timestamptz not null default now(),
  unique (invoice_id, line_no)
);
create index on invoice_lines (invoice_id);
create index on invoice_lines (inventory_item_id);
create index on invoice_lines (status);

create or replace view purchases_by_item as
select
  d.location_id,
  l.inventory_item_id,
  coalesce(d.received_date, d.invoice_date) as received_date,
  sum(l.quantity_base_unit)                 as quantity_base_unit,
  sum(l.extended_price)                     as cost
from invoice_lines l
join invoice_documents d on d.id = l.invoice_id
where d.status = 'posted'
  and l.status in ('auto_mapped','confirmed')
  and l.inventory_item_id is not null
group by 1, 2, 3;

create or replace view item_price_history as
select
  d.location_id,
  l.inventory_item_id,
  d.vendor_id,
  coalesce(d.received_date, d.invoice_date) as received_date,
  l.cost_per_base_unit,
  l.quantity_base_unit,
  d.id                                      as invoice_id
from invoice_lines l
join invoice_documents d on d.id = l.invoice_id
where d.status = 'posted'
  and l.status in ('auto_mapped','confirmed')
  and l.inventory_item_id is not null
  and l.cost_per_base_unit is not null;

create or replace view unit_cogs_master as
select distinct on (ii.tenant_id, ii.id)
  ii.tenant_id,
  ii.id                                     as inventory_item_id,
  ii.name,
  ii.category,
  ii.base_unit,
  ii.pack_to_base_factor,
  h.cost_per_base_unit                      as latest_cost_per_base_unit,
  h.cost_per_base_unit * coalesce(ii.pack_to_base_factor, 1) as latest_cost_per_pack,
  h.received_date                           as latest_price_date,
  h.vendor_id                               as latest_vendor_id,
  ii.cost_per_base_unit                     as cost_on_file
from inventory_items ii
left join item_price_history h on h.inventory_item_id = ii.id
order by ii.tenant_id, ii.id, h.received_date desc nulls last;

-- VENDOR PRICE COMPARISON
create or replace view vendor_price_latest as
select distinct on (ii.tenant_id, l.inventory_item_id, m.id)
  ii.tenant_id,
  l.inventory_item_id,
  ii.name                                   as inventory_item_name,
  ii.base_unit,
  m.id                                      as mapping_id,
  m.vendor_id,
  v.name                                    as vendor_name,
  m.brand,
  m.vendor_sku,
  coalesce(m.pack_description, l.pack_size_text, l.description) as pack_description,
  m.units_per_pack * m.base_units_per_unit  as base_units_per_pack,
  l.unit_price                              as price_per_pack,
  l.cost_per_base_unit,
  coalesce(d.received_date, d.invoice_date) as price_date
from invoice_lines l
join invoice_documents d      on d.id = l.invoice_id
join vendor_item_mappings m   on m.id = l.mapping_id
join vendors v                on v.id = m.vendor_id
join inventory_items ii       on ii.id = l.inventory_item_id
where d.status = 'posted'
  and l.status in ('auto_mapped','confirmed')
  and l.cost_per_base_unit is not null
  and l.quantity > 0
order by ii.tenant_id, l.inventory_item_id, m.id, coalesce(d.received_date, d.invoice_date) desc;

create or replace view vendor_price_comparison as
with ranked as (
  select p.*,
         min(p.cost_per_base_unit) over (partition by p.tenant_id, p.inventory_item_id) as best_cost_per_base_unit,
         count(*) over (partition by p.tenant_id, p.inventory_item_id) as option_count
  from vendor_price_latest p
)
select
  r.*,
  r.cost_per_base_unit - r.best_cost_per_base_unit         as premium_per_base_unit,
  case when r.best_cost_per_base_unit = 0 then null
       else r.cost_per_base_unit / r.best_cost_per_base_unit - 1 end as premium_pct,
  (r.cost_per_base_unit = r.best_cost_per_base_unit)      as is_cheapest
from ranked r
where r.option_count >= 2;

create table stock_counts (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null references locations(id) on delete cascade,
  inventory_item_id   uuid not null references inventory_items(id) on delete cascade,
  count_date          date not null,
  position            count_position not null default 'close',
  counted_at          timestamptz not null default now(),
  quantity_base_unit  numeric(14,4) not null,
  verification        verification_type not null default 'counted',
  estimate_at_count   numeric(14,4),
  counted_by          uuid,
  note                text,
  created_at          timestamptz not null default now(),
  unique (location_id, inventory_item_id, count_date, position)
);
create index on stock_counts (location_id, inventory_item_id, count_date desc);

-- UNIT CONVERSION
create or replace function convert_factor(from_unit uom, to_unit uom)
returns numeric language plpgsql immutable as $$
declare
  vol jsonb := '{"oz":29.5735,"ml":1,"l":1000}';
  mass jsonb := '{"g":1,"kg":1000,"lb":453.592}';
begin
  if from_unit = to_unit then return 1; end if;
  if vol ? from_unit::text and vol ? to_unit::text then
    return (vol ->> from_unit::text)::numeric / (vol ->> to_unit::text)::numeric;
  end if;
  if mass ? from_unit::text and mass ? to_unit::text then
    return (mass ->> from_unit::text)::numeric / (mass ->> to_unit::text)::numeric;
  end if;
  return 1;
end $$;

-- USAGE
create or replace view usage_by_period as
select
  s.location_id,
  rc.inventory_item_id,
  ii.name                                                   as inventory_item_name,
  ii.base_unit,
  s.business_date,
  sum(s.quantity_sold * rc.quantity * convert_factor(rc.unit, ii.base_unit)) as quantity_used,
  sum(s.quantity_sold * rc.quantity * convert_factor(rc.unit, ii.base_unit)
      * coalesce(ii.cost_per_base_unit, 0))                 as usage_cost
from sales_facts s
join recipe_components rc on rc.menu_item_id = s.menu_item_id
join inventory_items  ii on ii.id = rc.inventory_item_id
group by 1, 2, 3, 4, 5;

create or replace view usage_by_menu_item as
select
  s.location_id,
  s.menu_item_id,
  mi.name                                                   as menu_item_name,
  sum(s.quantity_sold)                                      as units_sold,
  rc.inventory_item_id,
  ii.name                                                   as inventory_item_name,
  ii.base_unit,
  sum(s.quantity_sold * rc.quantity * convert_factor(rc.unit, ii.base_unit)) as quantity_used
from sales_facts s
join menu_items       mi on mi.id = s.menu_item_id
join recipe_components rc on rc.menu_item_id = s.menu_item_id
join inventory_items  ii on ii.id = rc.inventory_item_id
group by 1, 2, 3, 5, 6, 7;

create or replace view vendor_switch_savings as
with usage_30d as (
  select u.location_id, u.inventory_item_id, sum(u.quantity_used) as used_30d
  from usage_by_period u
  where u.business_date > current_date - 30
  group by 1, 2
)
select
  loc.id                                    as location_id,
  c.inventory_item_id,
  c.inventory_item_name,
  c.base_unit,
  c.vendor_name                             as current_vendor,
  c.pack_description                        as current_pack,
  c.cost_per_base_unit                      as current_cost,
  b.vendor_name                             as cheapest_vendor,
  b.pack_description                        as cheapest_pack,
  b.cost_per_base_unit                      as cheapest_cost,
  c.premium_pct,
  coalesce(u.used_30d, 0)                   as used_30d,
  coalesce(u.used_30d, 0) * c.premium_per_base_unit        as savings_30d,
  coalesce(u.used_30d, 0) * c.premium_per_base_unit * 12   as savings_annualized
from vendor_price_comparison c
join vendor_price_comparison b
  on b.tenant_id = c.tenant_id and b.inventory_item_id = c.inventory_item_id and b.is_cheapest
join locations loc on loc.tenant_id = c.tenant_id
left join usage_30d u on u.location_id = loc.id and u.inventory_item_id = c.inventory_item_id
where not c.is_cheapest;

create or replace view menu_item_cost as
select
  mi.tenant_id,
  mi.id                                                     as menu_item_id,
  mi.name                                                   as menu_item_name,
  mi.category,
  mi.price                                                  as menu_price,
  mi.recipe_status,
  count(rc.id)                                              as component_count,
  sum(rc.quantity * convert_factor(rc.unit, ii.base_unit) * coalesce(ii.cost_per_base_unit, 0)) as plate_cost,
  case when coalesce(mi.price, 0) = 0 then null
       else sum(rc.quantity * convert_factor(rc.unit, ii.base_unit) * coalesce(ii.cost_per_base_unit, 0)) / mi.price end as cost_pct,
  bool_and(ii.cost_per_base_unit is not null)               as all_costs_known,
  bool_and(rc.source = 'confirmed')                         as recipe_confirmed
from menu_items mi
left join recipe_components rc on rc.menu_item_id = mi.id
left join inventory_items ii   on ii.id = rc.inventory_item_id
group by mi.tenant_id, mi.id, mi.name, mi.category, mi.price, mi.recipe_status;

-- ON-HAND ESTIMATE
create or replace view on_hand_estimate as
with last_count as (
  select distinct on (location_id, inventory_item_id)
         location_id, inventory_item_id, count_date, position, counted_at,
         quantity_base_unit, verification,
         case when position = 'open' then count_date else count_date + 1 end as since_date
  from stock_counts
  order by location_id, inventory_item_id, count_date desc, position desc
),
items as (
  select l.id as location_id, ii.id as inventory_item_id, ii.name, ii.base_unit,
         ii.cost_per_base_unit, ii.pack_to_base_factor
  from locations l
  join inventory_items ii on ii.tenant_id = l.tenant_id
),
purch as (
  select i.location_id, i.inventory_item_id, sum(p.quantity_base_unit) as purchased
  from items i
  join purchases_by_item p on p.location_id = i.location_id and p.inventory_item_id = i.inventory_item_id
  left join last_count c on c.location_id = i.location_id and c.inventory_item_id = i.inventory_item_id
  where c.since_date is null or p.received_date >= c.since_date
  group by 1, 2
),
used as (
  select i.location_id, i.inventory_item_id, sum(u.quantity_used) as used
  from items i
  join usage_by_period u on u.location_id = i.location_id and u.inventory_item_id = i.inventory_item_id
  left join last_count c on c.location_id = i.location_id and c.inventory_item_id = i.inventory_item_id
  where c.since_date is null or u.business_date >= c.since_date
  group by 1, 2
)
select
  i.location_id,
  i.inventory_item_id,
  i.name                                     as inventory_item_name,
  i.base_unit,
  c.count_date                               as last_count_date,
  c.position                                 as last_count_position,
  c.counted_at                               as last_verified_at,
  c.verification                             as last_verification,
  (c.count_date is not null)                 as has_baseline,
  coalesce(c.quantity_base_unit, 0)          as last_count_qty,
  coalesce(p.purchased, 0)                   as purchased_since,
  coalesce(u.used, 0)                        as used_since,
  coalesce(c.quantity_base_unit, 0) + coalesce(p.purchased, 0) - coalesce(u.used, 0) as on_hand_qty,
  (coalesce(c.quantity_base_unit, 0) + coalesce(p.purchased, 0) - coalesce(u.used, 0)) * coalesce(i.cost_per_base_unit, 0) as on_hand_value,
  i.pack_to_base_factor,
  case when coalesce(i.pack_to_base_factor, 0) > 0
       then (coalesce(c.quantity_base_unit, 0) + coalesce(p.purchased, 0) - coalesce(u.used, 0)) / i.pack_to_base_factor end as on_hand_packs
from items i
left join last_count c on c.location_id = i.location_id and c.inventory_item_id = i.inventory_item_id
left join purch p on p.location_id = i.location_id and p.inventory_item_id = i.inventory_item_id
left join used u on u.location_id = i.location_id and u.inventory_item_id = i.inventory_item_id;

create or replace view count_variance as
with counts as (
  select sc.*,
         case when sc.position = 'open' then sc.count_date else sc.count_date + 1 end as since_date,
         case when sc.position = 'open' then sc.count_date - 1 else sc.count_date end  as through_date,
         lag(quantity_base_unit) over w as prev_qty,
         lag(count_date)         over w as prev_count_date,
         lag(position)           over w as prev_position,
         lag(case when sc.position = 'open' then sc.count_date else sc.count_date + 1 end) over w as prev_since_date
  from stock_counts sc
  window w as (partition by location_id, inventory_item_id order by count_date, position)
),
windowed as (
  select c.*,
         coalesce((select sum(p.quantity_base_unit) from purchases_by_item p
                   where p.location_id = c.location_id and p.inventory_item_id = c.inventory_item_id
                     and p.received_date >= c.prev_since_date and p.received_date <= c.through_date), 0) as purchased,
         coalesce((select sum(u.quantity_used) from usage_by_period u
                   where u.location_id = c.location_id and u.inventory_item_id = c.inventory_item_id
                     and u.business_date >= c.prev_since_date and u.business_date <= c.through_date), 0) as theoretical_used
  from counts c
  where c.prev_count_date is not null
)
select
  w.location_id, w.inventory_item_id,
  w.prev_count_date, w.prev_position, w.count_date, w.position, w.verification,
  w.prev_qty, w.purchased, w.theoretical_used,
  w.prev_qty + w.purchased - w.theoretical_used    as expected_qty,
  w.quantity_base_unit                             as actual_qty,
  w.prev_qty + w.purchased - w.theoretical_used - w.quantity_base_unit as variance_qty,
  (w.prev_qty + w.purchased - w.theoretical_used - w.quantity_base_unit) * coalesce(ii.cost_per_base_unit, 0) as variance_value,
  case when coalesce(ii.pack_to_base_factor, 0) > 0
       then (w.prev_qty + w.purchased - w.theoretical_used - w.quantity_base_unit) / ii.pack_to_base_factor end as variance_packs
from windowed w
join inventory_items ii on ii.id = w.inventory_item_id;

-- VERIFICATION QUEUE
create or replace view verification_queue as
with vel as (
  select location_id, inventory_item_id, sum(quantity_used) / 14.0 as used_per_day
  from usage_by_period
  where business_date > current_date - 14
  group by 1, 2
),
price_then as (
  select distinct on (ii.tenant_id, h.inventory_item_id)
         ii.tenant_id, h.inventory_item_id, h.cost_per_base_unit as cost_30d_ago
  from item_price_history h
  join inventory_items ii on ii.id = h.inventory_item_id
  where h.received_date <= current_date - 30
  order by ii.tenant_id, h.inventory_item_id, h.received_date desc
),
base as (
  select
    e.location_id, e.inventory_item_id, e.inventory_item_name, e.base_unit,
    ii.category, ii.tenant_id,
    e.on_hand_qty, e.on_hand_packs, e.on_hand_value, ii.pack_to_base_factor,
    e.last_verified_at, e.last_count_date, e.has_baseline,
    coalesce(ii.cost_per_base_unit, 0)                          as cost_per_base_unit,
    coalesce(v.used_per_day, 0)                                 as used_per_day,
    coalesce(v.used_per_day, 0) * coalesce(ii.cost_per_base_unit, 0) as daily_burn_value,
    coalesce(current_date - e.last_count_date, 30)              as days_since_verified,
    case when coalesce(p.cost_30d_ago, 0) > 0 then ii.cost_per_base_unit / p.cost_30d_ago - 1 end as price_change_30d
  from on_hand_estimate e
  join inventory_items ii on ii.id = e.inventory_item_id
  left join vel v on v.location_id = e.location_id and v.inventory_item_id = e.inventory_item_id
  left join price_then p on p.tenant_id = ii.tenant_id and p.inventory_item_id = e.inventory_item_id
)
select
  b.*,
  b.daily_burn_value * b.days_since_verified                    as exposure_value,
  case when b.used_per_day = 0 then null else b.on_hand_qty / b.used_per_day end as days_of_supply,
  b.cost_per_base_unit * b.pack_to_base_factor                  as value_per_pack,
  (b.daily_burn_value * b.days_since_verified) * (1 + greatest(coalesce(b.price_change_30d, 0), 0))
    + 0.05 * greatest(b.on_hand_value, 0)
    + case when not b.has_baseline then 1e9 + b.daily_burn_value else 0 end as priority_score,
  case
    when not b.has_baseline then 'never verified'
    when coalesce(b.price_change_30d, 0) >= 0.25 then 'price up ' || round(b.price_change_30d * 100) || '% in 30d'
    when b.daily_burn_value * b.days_since_verified >= 200 then 'high $ flow since last check'
    when b.days_since_verified >= 14 then 'stale'
    else 'routine'
  end as reason
from base b;
