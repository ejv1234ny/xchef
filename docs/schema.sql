-- ============================================================================
--  xchef — Usage-Tracking Schema (Supabase / Postgres) — ANNOTATED
--  The exact SQL applied to xchef-dev lives in supabase/migrations/20260904002855_init.sql
--  (identical DDL, comments stripped) and 20260904002929_rls.sql. Edit here, then cut a
--  new migration; never re-run 0001.
--
--  Focus: theoretical USAGE from sales × recipe, receiving via AI-parsed
--  invoices, on-hand from verified counts, vendor price comparison.
--  Headline: "Based on 72 margaritas sold you used 108 oz tequila ..."
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
--  ENUMS
-- ----------------------------------------------------------------------------

-- Units the app reasons in. Physical units convert automatically (convert_factor).
-- Pack units (case/bottle/can/each) are item-specific via pack_to_base_factor.
create type uom as enum (
  'oz','ml','l','g','kg','lb',          -- physical (auto-convertible)
  'each','case','bottle','can'          -- pack/count (item-specific)
);

-- How a recipe line came to exist, so the UI can show what still needs review.
create type recipe_source as enum (
  'ai_draft',           -- guessed by AI from the menu item name/description
  'reverse_engineered', -- inferred from sales + purchase/count calibration
  'confirmed'           -- a human confirmed it
);
create type recipe_status as enum ('draft','needs_review','confirmed');

-- Invoice ingestion pipeline states.
create type invoice_status as enum (
  'received',      -- attachment landed via inbound email / upload
  'parsing',       -- sent to the LLM
  'needs_review',  -- parsed; some lines unmapped or low confidence
  'posted',        -- every line mapped/ignored; purchases now count toward on-hand
  'rejected'       -- not an invoice (statement, marketing, duplicate)
);
create type invoice_line_status as enum (
  'unmapped',      -- no vendor_item_mapping matched
  'auto_mapped',   -- matched via existing mapping or high-confidence AI guess
  'confirmed',     -- human confirmed the mapping
  'ignored'        -- non-inventory line (delivery fee, deposit, tax)
);

-- A verification is either a tap that confirms the estimate, or a real count.
create type verification_type as enum ('confirmed_estimate','counted');
-- Whether a count reflects the START of the business day (before open / before
-- deliveries) or the END (after close). Decides which same-day purchases and
-- sales are "since" the count.
create type count_position as enum ('open','close');

-- Intake channels: vendor bills the inbound address, operator forwards an email,
-- uploads a scan/photo, pastes invoice text, keys it in by hand, or API.
create type invoice_source as enum ('email','forward','upload','paste','manual','api');

-- ----------------------------------------------------------------------------
--  TENANCY
-- ----------------------------------------------------------------------------

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                 -- the Toast management group / company
  created_at  timestamptz not null default now()
);

create table locations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  name                 text not null,
  toast_location_guid  text unique,          -- Toast restaurant GUID (per-location API)
  timezone             text not null default 'America/New_York',
  created_at           timestamptz not null default now()
);
create index on locations (tenant_id);

-- Links Supabase auth users -> tenants, for row-level security.
create table memberships (
  user_id     uuid not null,                 -- references auth.users(id)
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null default 'member',-- 'owner' | 'manager' | 'member'
  created_at  timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- Toast Standard API access = read-only credentials the customer generates
-- themselves. One set per location (requests are location-scoped).
-- Store the secret in Supabase Vault; this column holds the Vault reference.
create table toast_credentials (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null references locations(id) on delete cascade,
  client_id                text not null,
  client_secret_encrypted  text not null,
  last_synced_at           timestamptz,
  created_at               timestamptz not null default now(),
  unique (location_id)
);

-- ----------------------------------------------------------------------------
--  CATALOGS
-- ----------------------------------------------------------------------------

-- The "things used" — raw ingredients reported in a single base unit.
-- Tenant-scoped so a management group shares one catalog across locations.
create table inventory_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  name                  text not null,        -- "Tequila - Blanco", "Limes", "Flour AP"
  category              text,                 -- 'liquor' | 'produce' | 'dry' | ...
  base_unit             uom  not null,        -- the unit USAGE is reported in (oz, lb, each)
  pack_to_base_factor   numeric(12,4),        -- e.g. bottle of tequila = 25.36 (oz); case of tomatoes = 25 (lb)
  cost_per_base_unit    numeric(12,4),        -- refreshed from latest posted invoice line
  created_at            timestamptz not null default now(),
  unique (tenant_id, name)
);
create index on inventory_items (tenant_id);

-- Menu items from Toast Menus v2 (or menu upload), matched to Toast sales by GUID.
create table menu_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  toast_menu_item_guid  text,                 -- selection.item.guid in ordersBulk
  name                  text not null,        -- "Classic Margarita"
  category              text,                 -- 'cocktails' | 'entrees' | ...
  price                 numeric(12,2),
  recipe_status         recipe_status not null default 'draft',
  created_at            timestamptz not null default now(),
  unique (tenant_id, toast_menu_item_guid),
  unique (tenant_id, name)
);
create index on menu_items (tenant_id);

-- ----------------------------------------------------------------------------
--  RECIPES (bill of materials) — the join that powers usage
-- ----------------------------------------------------------------------------

create table recipe_components (
  id                 uuid primary key default gen_random_uuid(),
  menu_item_id       uuid not null references menu_items(id) on delete cascade,
  inventory_item_id  uuid not null references inventory_items(id) on delete restrict,
  quantity           numeric(12,4) not null,  -- 1.5
  unit               uom  not null,           -- 'oz'
  source             recipe_source not null default 'ai_draft',
  confidence         numeric(3,2),            -- 0.00–1.00 (AI confidence, for the Q&A queue)
  confirmed_by       uuid,                    -- auth.users(id)
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  unique (menu_item_id, inventory_item_id)
);
create index on recipe_components (menu_item_id);
create index on recipe_components (inventory_item_id);

-- ----------------------------------------------------------------------------
--  SALES — Toast Orders API (GET /orders/v1/ordersBulk), flattened
--  Order -> Check -> Selection and rolled up per item per business day.
--  NOTE: the Analytics API (/era) is NOT part of Standard API access (needs
--  RMS Pro); Orders is the source. Modifier selections that carry their own
--  item GUID (e.g. "sub Patrón") roll up as their own rows so a modifier can
--  have its own recipe.
-- ----------------------------------------------------------------------------

-- Raw orders keyed by GUID and upserted every sync (orders get modified after
-- creation: voids, refunds, late closes). sales_facts is a pure rollup of this
-- table, so any business date can be recomputed idempotently. Keep ~90 days.
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

-- Per-item, per-business-day rollup, rebuilt from toast_orders_raw for each
-- business date touched by a sync run.
create table sales_facts (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id) on delete cascade,
  menu_item_id          uuid references menu_items(id) on delete set null,
  toast_menu_item_guid  text,                 -- raw guid, kept even if mapping is pending
  business_date         date not null,
  quantity_sold         numeric(12,2) not null,  -- non-voided quantity
  quantity_voided       numeric(12,2) not null default 0,
  net_sales             numeric(12,2),
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (location_id, toast_menu_item_guid, business_date)
);
create index on sales_facts (location_id, business_date);
create index on sales_facts (menu_item_id);

-- ----------------------------------------------------------------------------
--  RECEIVING — automated invoice ingestion (email/upload -> LLM parse ->
--  vendor SKU mapping -> purchases). The operator only confirms new vendor
--  SKUs the first time they appear.
-- ----------------------------------------------------------------------------

-- Each location gets an inbound address invoices-<slug>@<domain> that the
-- operator gives to vendors as the billing email.
alter table locations
  add column inbound_email_slug text unique;   -- 'madmoose' -> invoices-madmoose@...

create table vendors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,                 -- "Sysco", "Baldor", "VT Liquor"
  email_domains text[] default '{}',         -- used to auto-attribute inbound mail
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
  storage_path     text not null,            -- Supabase Storage object (pdf/jpg)
  email_from       text,
  email_subject    text,
  email_message_id text,                     -- dedupe re-forwarded mail
  content_hash     text,                     -- sha256 of attachment; dedupe re-sends
  invoice_number   text,
  invoice_date     date,
  received_date    date,                     -- when goods arrived (defaults to invoice_date)
  subtotal         numeric(12,2),
  tax              numeric(12,2),
  total            numeric(12,2),
  parse_confidence numeric(3,2),
  raw_extraction   jsonb,                    -- full LLM structured output, kept for audit
  parse_error      text,
  posted_at        timestamptz,
  created_at       timestamptz not null default now(),
  unique (location_id, content_hash)
);
create index on invoice_documents (location_id, status);
create index on invoice_documents (vendor_id, invoice_number);

-- "TEQUILA BLANCO 750ML 6/CS" -> inventory_items "Tequila - Blanco" (oz).
-- Learned once, reused forever. units_per_pack × base_units_per_unit turns an
-- invoice quantity into base units: 2 cases × 6 × 25.36 = 304.3 oz.
-- Pack sizes come from the parsed label first, a standard-pack default second,
-- and the owner's edit here overrides both. Never a hardcoded constant.
create table vendor_item_mappings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  vendor_id            uuid not null references vendors(id) on delete cascade,
  vendor_sku           text,                 -- vendor's item code when present
  description_norm     text not null,        -- lowercased/trimmed description, fallback key
  inventory_item_id    uuid not null references inventory_items(id) on delete cascade,
  units_per_pack       numeric(12,4) not null default 1,   -- 6 bottles per case
  base_units_per_unit  numeric(12,4) not null,             -- 25.36 oz per bottle
  pack_description     text,                 -- human form: "6 × #10 can"
  brand                text,                 -- "Hunt's", "Heinz" — same ingredient, different brand
  confirmed_by         uuid,                 -- auth.users(id); null = AI-suggested only
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
  -- as parsed from the document
  vendor_sku          text,
  description         text not null,
  pack_size_text      text,                  -- "6/750ML", "40 LB", "CS"
  quantity            numeric(12,4) not null,-- invoice units (cases, each, lb); negative for credits
  unit_price          numeric(12,4),
  extended_price      numeric(12,2),
  ai_category_guess   text,                  -- 'liquor' | 'produce' | ...
  ai_confidence       numeric(3,2),
  -- resolution
  status              invoice_line_status not null default 'unmapped',
  mapping_id          uuid references vendor_item_mappings(id) on delete set null,
  inventory_item_id   uuid references inventory_items(id) on delete set null,
  quantity_base_unit  numeric(14,4),         -- quantity × units_per_pack × base_units_per_unit
  cost_per_base_unit  numeric(12,6),         -- extended_price / quantity_base_unit (feeds COGS)
  created_at          timestamptz not null default now(),
  unique (invoice_id, line_no)
);
create index on invoice_lines (invoice_id);
create index on invoice_lines (inventory_item_id);
create index on invoice_lines (status);

-- Purchases in base units, per location/item/date — only from POSTED invoices.
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

-- Price history per posted line (trend source for the master list and queue).
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

-- Master unit-cost list: every ingredient with its latest invoice price per
-- base unit and per pack, where it came from, and the cost currently on file.
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

-- ----------------------------------------------------------------------------
--  VENDOR PRICE COMPARISON — the same ingredient from different vendors in
--  different pack sizes, normalized to cost per base unit. Distributors pack
--  less and price lower to look cheaper; this makes pack size irrelevant.
--  e.g. ketchup: 6 × #10 cans @ $62.50 vs 3 × 114 oz bags @ $67.19 — the cans
--  are ~half the price per oz whether a #10 is taken as 114 or 128 oz.
-- ----------------------------------------------------------------------------

-- Latest price per (ingredient, vendor, pack format), tenant-wide.
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
  m.units_per_pack * m.base_units_per_unit  as base_units_per_pack,   -- shown in UI
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

-- Side-by-side: every current option for an ingredient vs the cheapest one.
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

-- Verifications: a ✓ tap (confirmed_estimate) or a real count. Each one resets
-- the on-hand baseline; `position` decides whether same-day activity is "since".
create table stock_counts (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null references locations(id) on delete cascade,
  inventory_item_id   uuid not null references inventory_items(id) on delete cascade,
  count_date          date not null,         -- business date the count belongs to
  position            count_position not null default 'close',
  counted_at          timestamptz not null default now(),
  quantity_base_unit  numeric(14,4) not null,
  verification        verification_type not null default 'counted',
  estimate_at_count   numeric(14,4),         -- what the app showed when they tapped (audit)
  counted_by          uuid,                  -- auth.users(id)
  note                text,
  created_at          timestamptz not null default now(),
  unique (location_id, inventory_item_id, count_date, position)
);
create index on stock_counts (location_id, inventory_item_id, count_date desc);

-- ----------------------------------------------------------------------------
--  UNIT CONVERSION (physical units only; pack units handled per-item)
-- ----------------------------------------------------------------------------

create or replace function convert_factor(from_unit uom, to_unit uom)
returns numeric language plpgsql immutable as $$
declare
  vol jsonb := '{"oz":29.5735,"ml":1,"l":1000}';    -- volume -> ml
  mass jsonb := '{"g":1,"kg":1000,"lb":453.592}';    -- mass -> g
begin
  if from_unit = to_unit then return 1; end if;
  if vol ? from_unit::text and vol ? to_unit::text then
    return (vol ->> from_unit::text)::numeric / (vol ->> to_unit::text)::numeric;
  end if;
  if mass ? from_unit::text and mass ? to_unit::text then
    return (mass ->> from_unit::text)::numeric / (mass ->> to_unit::text)::numeric;
  end if;
  return 1;  -- incompatible / pack units: assume recipe authored in base unit
end $$;

-- ----------------------------------------------------------------------------
--  USAGE — the headline output (theoretical depletion from sales × recipe)
-- ----------------------------------------------------------------------------

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

-- "72 margaritas -> 108 oz tequila"
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

-- What switching vendors would save, using the last 30 days of theoretical
-- usage as the run-rate. One row per non-cheapest option. The "you're
-- overpaying for…" list.
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

-- Plate / drink cost: recipe × unit cost vs menu price. AI-drafted, owner-verified.
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

-- ----------------------------------------------------------------------------
--  ON-HAND ESTIMATE
--  on_hand = last verified count + purchases since − theoretical usage since.
--  Because this is a view keyed off the latest stock_counts row, every ✓ tap
--  or typed count resets the baseline and recalculates instantly.
--  Never counted -> baseline 0, has_baseline = false ("net change").
-- ----------------------------------------------------------------------------

create or replace view on_hand_estimate as
with last_count as (
  select distinct on (location_id, inventory_item_id)
         location_id, inventory_item_id, count_date, position, counted_at,
         quantity_base_unit, verification,
         -- first business date whose activity is AFTER the count
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
  -- for the "you should have 24 lb of chicken / half a case" checklist
  case when coalesce(i.pack_to_base_factor, 0) > 0
       then (coalesce(c.quantity_base_unit, 0) + coalesce(p.purchased, 0) - coalesce(u.used, 0)) / i.pack_to_base_factor end as on_hand_packs
from items i
left join last_count c on c.location_id = i.location_id and c.inventory_item_id = i.inventory_item_id
left join purch p on p.location_id = i.location_id and p.inventory_item_id = i.inventory_item_id
left join used u on u.location_id = i.location_id and u.inventory_item_id = i.inventory_item_id;

-- Variance at each count: expected (prev + purchased − used) vs actual, in
-- units, packs and dollars. Positive = unexplained depletion (over-pour, comps,
-- theft). Windows respect open/close position. Use verification='counted'
-- rows for charts and calibration; a ✓ is zero-variance by construction.
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

-- ----------------------------------------------------------------------------
--  VERIFICATION QUEUE — what the app asks the owner to eyeball next, ordered
--  by how fast you can lose money on the item:
--    daily_burn_value = usage/day × current cost      (expensive × high-volume)
--    exposure_value   = burn × days since verified     (what could be hiding)
--    price_change_30d = current cost vs ~30 days ago   (tomatoes doubled -> 2×)
--    priority_score   = exposure × (1 + price_shock⁺) + 5% of on-hand value;
--                       never-verified items on top, ranked by burn.
-- ----------------------------------------------------------------------------

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
  b.cost_per_base_unit * b.pack_to_base_factor                  as value_per_pack,   -- a case of discrepancy in $
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

-- ----------------------------------------------------------------------------
--  ROW-LEVEL SECURITY: see supabase/migrations/20260904002929_rls.sql (applied).
--  Every table is scoped to the caller's memberships; views run as invoker.
--  Cron and inbound routes use the service-role key and bypass RLS.
-- ----------------------------------------------------------------------------

-- ============================================================================
--  MIGRATION 0003 (supabase/migrations/20260904010000_sync_runs.sql, applied)
--  sync_runs: one row per Toast sync / backfill / menu-sync execution, so the
--  Settings page and the report can show "last sync 4 min ago, 312 orders,
--  3 business dates rebuilt" without a job dashboard.
-- ============================================================================
create table sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null references locations(id) on delete cascade,
  kind               text not null default 'toast-sync',   -- 'toast-sync' | 'toast-backfill' | 'menu-sync'
  window_start       timestamptz,
  window_end         timestamptz,
  orders_fetched     int  not null default 0,
  orders_upserted    int  not null default 0,
  orders_quarantined int  not null default 0,               -- failed zod validation; logged and skipped
  dates_rebuilt      date[] not null default '{}',
  duration_ms        int,
  error              text,
  created_at         timestamptz not null default now()
);
create index on sync_runs (location_id, created_at desc);
alter table sync_runs enable row level security;
create policy location_isolation on sync_runs for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

-- Toast client secret lives in Supabase Vault. toast_credentials.client_secret_encrypted
-- stores the vault secret's uuid, never the secret. A tenant member may SET the
-- credentials for their own location (server action); only the service role may
-- READ the secret back (cron route), so the browser never sees it.
--   set_toast_credentials(location_id, client_id, client_secret)  -> void
--   get_toast_client_secret(location_id)                          -> text  (service_role only)

-- ============================================================================
--  MIGRATION 0004 (20260904020000_replace_sales_facts.sql, applied)
--  replace_sales_facts(location_id, dates[], rows jsonb) -> int
--    Atomic delete+insert of sales_facts for exactly those business dates;
--    links menu_item_id by toast_menu_item_guid. One RPC == one transaction.
--  relink_sales_facts(location_id) -> int
--    After a menu sync, fills menu_item_id on older sales_facts rows.
--  Both are service_role only.
--
--  MIGRATION 0005 (20260904030000_llm_calls.sql, applied)
--  llm_calls: one row per Claude call — kind, ref_id, model, tokens, cost_usd,
--  raw output. invoice_documents.raw_extraction keeps the parse; this table is
--  the cost log and the raw store for recipe drafts and SKU matches.
-- ============================================================================

-- ============================================================================
--  MIGRATION 0006 (20260904040000_vendor_sheet_layouts.sql, applied)
--  vendor_sheet_layouts: learned column maps for spreadsheet invoices
--  (csv/tsv/xlsx/xls). header_fingerprint = sha256 of the normalized header
--  row; column_map = { "<column index>": role } with roles vendor_sku |
--  description | pack_size | quantity | unit_price | extended_price |
--  invoice_number | invoice_date | vendor_name | ignore; source = builtin
--  (lib/core/sheets.ts KNOWN_LAYOUTS) | ai (Haiku, once per fingerprint) |
--  heuristic (header synonyms) | human (edited on the review screen).
--  unique (tenant_id, header_fingerprint) — the same export layout never
--  asks twice. RLS: tenant_isolation like vendor_item_mappings.
-- ============================================================================
create table vendor_sheet_layouts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  vendor_id           uuid references vendors(id) on delete set null,
  header_fingerprint  text not null,
  header_cells        text[] not null default '{}',
  column_map          jsonb not null,
  source              text not null default 'ai',
  confidence          numeric(3,2),
  confirmed_by        uuid,
  confirmed_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, header_fingerprint)
);
create index on vendor_sheet_layouts (tenant_id);
create index on vendor_sheet_layouts (vendor_id);
alter table vendor_sheet_layouts enable row level security;
create policy tenant_isolation on vendor_sheet_layouts for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

-- ============================================================================
--  MIGRATION 0007 (20260904050000_inbound_events.sql, applied)
--  inbound_events: one row per inbound email webhook delivery (Resend; Postmark
--  while deprecated) whether or not a document was created — provider,
--  event_type, email_id, message_id, from/to, subject, attachment_count,
--  documents_created, document_ids, error. Written by the service role only;
--  members of the location's tenant can read it.
-- ============================================================================
create table inbound_events (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid references locations(id) on delete set null,
  provider           text not null,
  event_type         text not null,
  email_id           text,
  message_id         text,
  from_address       text,
  to_addresses       text[] not null default '{}',
  subject            text,
  attachment_count   int  not null default 0,
  documents_created  int  not null default 0,
  document_ids       uuid[] not null default '{}',
  error              text,
  created_at         timestamptz not null default now()
);
create index on inbound_events (created_at desc);
create index on inbound_events (email_id);
create index on inbound_events (message_id);
alter table inbound_events enable row level security;
create policy location_read on inbound_events for select
  using (location_id in (select my_location_ids()));

-- MIGRATION 0008 (20260904060000_llm_calls_provider.sql, applied): llm_calls.provider ('openai' | 'anthropic').
alter table llm_calls add column provider text not null default 'anthropic';
create index on llm_calls (provider, created_at desc);

-- ============================================================================
--  MIGRATION 0009 (20260904070000_receipts_and_vendor_kind.sql, applied)
--  Multi-receipt scans + retail liquor receipts.
--  vendors.kind: 'distributor' (default) | 'retail_liquor' | 'other'.
--  invoice_documents.receipt_id      the unique printed number (barcode /
--                                    receipt number, else invoice number)
--  invoice_documents.transaction_code non-unique register/store codes
--                                    (e.g. "2017-2017-1-176") — never a key
--  invoice_documents.invoice_time, printed_item_count ("Total Sales Quantity 15")
--  Dedupe: unique (vendor_id, receipt_id) where receipt_id is not null;
--          unique (vendor_id, invoice_date, invoice_time, total) otherwise.
--  invoice_lines.gross_price, adjustment: discount/promo/deposit/credit lines
--  are folded into the preceding item; extended_price = gross − adjustment.
--  invoice_lines.pack_size_assumed: retail liquor bottle size defaulted to
--  750 ml when the receipt does not print one (shown and fixable in review).
-- ============================================================================
alter table vendors add column kind text not null default 'distributor'
  check (kind in ('distributor','retail_liquor','other'));
alter table invoice_documents
  add column receipt_id text,
  add column transaction_code text,
  add column invoice_time time,
  add column printed_item_count int;
create unique index invoice_documents_vendor_receipt_uidx
  on invoice_documents (vendor_id, receipt_id) where receipt_id is not null and vendor_id is not null;
create unique index invoice_documents_vendor_datetime_total_uidx
  on invoice_documents (vendor_id, invoice_date, invoice_time, total)
  where receipt_id is null and vendor_id is not null and invoice_date is not null and invoice_time is not null and total is not null;
alter table invoice_lines
  add column gross_price numeric(12,2),
  add column adjustment numeric(12,2),
  add column pack_size_assumed boolean not null default false;

-- ============================================================================
--  MIGRATION 20260905100000_tenant_concept (applied 2026-09-05)
-- ============================================================================
-- 0010: tenants.concept — the one-sentence description of the operation used
-- as recipe-drafting context (was hardcoded to Mad Moose in recipe-draft.ts).
alter table tenants add column if not exists concept text;
update tenants set concept = 'a bar & grill in Vermont (burgers, wings, sandwiches, salads, pub entrees, draft and canned beer, wine by the glass, classic cocktails and shots)'
 where name = 'Mad Moose' and concept is null;

-- ============================================================================
--  MIGRATION 20260905110000_daily_position (applied 2026-09-05)
-- ============================================================================
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

-- ============================================================================
--  MIGRATION 20260905120000_portal_attach (applied 2026-09-05)
-- ============================================================================
-- 0012: vendor-portal pull (fifth intake channel, source = 'api').
--  invoice_documents.clean_storage_path      the authoritative copy pulled from the
--                                            vendor portal, attached to the document
--                                            that first arrived as paper/photo
--  invoice_documents.verified_by_clean_copy_at  set when the clean copy's line totals
--                                            matched the posted lines within one cent
--  invoice_documents.parse_diff              "paper said / portal says" when they differ
--  invoice_documents.document_kind           invoice | credit | statement | other | quote
alter table invoice_documents
  add column if not exists clean_storage_path text,
  add column if not exists verified_by_clean_copy_at timestamptz,
  add column if not exists parse_diff jsonb,
  add column if not exists document_kind text;
create index if not exists invoice_documents_vendor_invoice_number_idx on invoice_documents (vendor_id, invoice_number);

-- ============================================================================
--  MIGRATION 20260905130000_quotes_forward_pricing (applied 2026-09-05)
-- ============================================================================
-- 0013: outbound quote requests → forward pricing model.
--  vendors.contact_email       where quote requests are sent
--  quote_requests              one row per email sent
--  vendor_quotes               one row per quoted line (never a purchase)
--  forward_price_model (view)  per ingredient × vendor: last invoiced, best valid
--                              quote, expected_next_cost + basis, 30-day trend
--  vendor_price_comparison / vendor_switch_savings are recomputed on
--  expected_next_cost and carry `basis`; the invoiced-only columns are kept.
alter table vendors add column if not exists contact_email text;

create table quote_requests (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  location_id         uuid references locations(id) on delete set null,
  vendor_id           uuid not null references vendors(id) on delete cascade,
  token               text not null unique,                 -- [Q-xxxxxx] in the subject
  sent_at             timestamptz not null default now(),
  resend_message_id   text,
  items               jsonb not null default '[]',          -- [{ mapping_id, vendor_sku, description, pack_description }]
  status              text not null default 'sent' check (status in ('sent','replied','no_reply')),
  reply_document_id   uuid references invoice_documents(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index on quote_requests (vendor_id, sent_at desc);
alter table quote_requests enable row level security;
create policy tenant_isolation on quote_requests for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

create table vendor_quotes (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  vendor_id            uuid not null references vendors(id) on delete cascade,
  inventory_item_id    uuid references inventory_items(id) on delete set null,
  mapping_id           uuid references vendor_item_mappings(id) on delete set null,
  vendor_sku           text,
  description          text not null,
  pack_description     text,
  units_per_pack       numeric(12,4) not null default 1,
  base_units_per_unit  numeric(12,4),
  quoted_unit_price    numeric(12,4),
  cost_per_base_unit   numeric(12,6),
  special_terms        text,
  min_quantity         numeric(12,4),
  valid_from           date,
  valid_through        date,
  source_document_id   uuid references invoice_documents(id) on delete set null,
  quote_request_id     uuid references quote_requests(id) on delete set null,
  received_at          timestamptz not null default now(),
  created_at           timestamptz not null default now()
);
create index on vendor_quotes (vendor_id, mapping_id, received_at desc);
create index on vendor_quotes (tenant_id, inventory_item_id);
alter table vendor_quotes enable row level security;
create policy tenant_isolation on vendor_quotes for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

-- Quotes never count as purchases (they are never posted, and the kind is excluded explicitly).
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
  and coalesce(d.document_kind, 'invoice') <> 'quote'
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
  and coalesce(d.document_kind, 'invoice') <> 'quote'
  and l.status in ('auto_mapped','confirmed')
  and l.inventory_item_id is not null
  and l.cost_per_base_unit is not null;

-- Latest valid quote per (vendor, ingredient).
create or replace view vendor_quotes_latest as
select distinct on (q.tenant_id, q.vendor_id, q.inventory_item_id)
  q.tenant_id, q.vendor_id, q.inventory_item_id, q.mapping_id, q.vendor_sku, q.description, q.pack_description,
  q.units_per_pack, q.base_units_per_unit, q.units_per_pack * coalesce(q.base_units_per_unit, 0) as base_units_per_pack,
  q.quoted_unit_price, q.cost_per_base_unit, q.special_terms, q.min_quantity, q.valid_from, q.valid_through, q.received_at, q.source_document_id
from vendor_quotes q
where q.inventory_item_id is not null and q.cost_per_base_unit is not null
order by q.tenant_id, q.vendor_id, q.inventory_item_id, q.received_at desc;

-- Forward price model: what you would pay next, per ingredient × vendor.
create or replace view forward_price_model as
with invoiced as (
  select distinct on (ii.tenant_id, h.inventory_item_id, h.vendor_id)
    ii.tenant_id, h.inventory_item_id, h.vendor_id, h.cost_per_base_unit, h.received_date
  from item_price_history h
  join inventory_items ii on ii.id = h.inventory_item_id
  order by ii.tenant_id, h.inventory_item_id, h.vendor_id, h.received_date desc
),
invoiced_30 as (
  select distinct on (ii.tenant_id, h.inventory_item_id, h.vendor_id)
    ii.tenant_id, h.inventory_item_id, h.vendor_id, h.cost_per_base_unit as cost_30d_ago
  from item_price_history h
  join inventory_items ii on ii.id = h.inventory_item_id
  where h.received_date <= current_date - 30
  order by ii.tenant_id, h.inventory_item_id, h.vendor_id, h.received_date desc
),
pairs as (
  select tenant_id, inventory_item_id, vendor_id from invoiced
  union
  select tenant_id, inventory_item_id, vendor_id from vendor_quotes_latest
)
select
  p.tenant_id,
  p.inventory_item_id,
  ii.name                                   as inventory_item_name,
  ii.base_unit,
  p.vendor_id,
  v.name                                    as vendor_name,
  i.cost_per_base_unit                      as last_invoiced_cost,
  i.received_date                           as last_invoiced_at,
  q.cost_per_base_unit                      as best_quoted_cost,
  q.valid_through                           as quote_valid_through,
  q.pack_description                        as quoted_pack,
  q.base_units_per_pack                     as quoted_base_units_per_pack,
  case when q.cost_per_base_unit is not null and (q.valid_through is null or q.valid_through >= current_date)
       then q.cost_per_base_unit else i.cost_per_base_unit end                             as expected_next_cost,
  case when q.cost_per_base_unit is not null and (q.valid_through is null or q.valid_through >= current_date)
       then 'quote' else 'invoice' end                                                     as basis,
  case when coalesce(i30.cost_30d_ago, 0) > 0 and i.cost_per_base_unit is not null
       then i.cost_per_base_unit / i30.cost_30d_ago - 1 end                                as trend_30d_pct
from pairs p
join inventory_items ii on ii.id = p.inventory_item_id
join vendors v on v.id = p.vendor_id
left join invoiced i on i.tenant_id = p.tenant_id and i.inventory_item_id = p.inventory_item_id and i.vendor_id = p.vendor_id
left join invoiced_30 i30 on i30.tenant_id = p.tenant_id and i30.inventory_item_id = p.inventory_item_id and i30.vendor_id = p.vendor_id
left join vendor_quotes_latest q on q.tenant_id = p.tenant_id and q.inventory_item_id = p.inventory_item_id and q.vendor_id = p.vendor_id;

-- Comparison and savings now run on expected_next_cost and say which basis produced each number.
drop view if exists vendor_switch_savings;
drop view if exists vendor_price_comparison;

create view vendor_price_comparison as
with latest as (
  select vpl.*, f.expected_next_cost, f.basis, f.quote_valid_through, f.best_quoted_cost
  from vendor_price_latest vpl
  left join forward_price_model f on f.tenant_id = vpl.tenant_id and f.inventory_item_id = vpl.inventory_item_id and f.vendor_id = vpl.vendor_id
  union all
  -- vendors that have only quoted (never invoiced) still take part
  select f.tenant_id, f.inventory_item_id, f.inventory_item_name, f.base_unit,
         q.mapping_id, f.vendor_id, f.vendor_name, null::text as brand, q.vendor_sku,
         coalesce(q.pack_description, q.description) as pack_description,
         q.base_units_per_pack, q.quoted_unit_price as price_per_pack, q.cost_per_base_unit, q.received_at::date as price_date,
         f.expected_next_cost, f.basis, f.quote_valid_through, f.best_quoted_cost
  from forward_price_model f
  join vendor_quotes_latest q on q.tenant_id = f.tenant_id and q.inventory_item_id = f.inventory_item_id and q.vendor_id = f.vendor_id
  where f.last_invoiced_cost is null
),
ranked as (
  select l.*,
         coalesce(l.expected_next_cost, l.cost_per_base_unit) as compare_cost,
         min(coalesce(l.expected_next_cost, l.cost_per_base_unit)) over (partition by l.tenant_id, l.inventory_item_id) as best_cost_per_base_unit,
         count(*) over (partition by l.tenant_id, l.inventory_item_id) as option_count
  from latest l
)
select
  r.tenant_id, r.inventory_item_id, r.inventory_item_name, r.base_unit, r.mapping_id, r.vendor_id, r.vendor_name, r.brand, r.vendor_sku,
  r.pack_description, r.base_units_per_pack, r.price_per_pack, r.cost_per_base_unit, r.price_date,
  r.best_cost_per_base_unit, r.option_count,
  r.compare_cost - r.best_cost_per_base_unit                          as premium_per_base_unit,
  case when r.best_cost_per_base_unit = 0 then null
       else r.compare_cost / r.best_cost_per_base_unit - 1 end       as premium_pct,
  (r.compare_cost = r.best_cost_per_base_unit)                        as is_cheapest,
  r.expected_next_cost, coalesce(r.basis, 'invoice') as basis, r.quote_valid_through, r.best_quoted_cost
from ranked r
where r.option_count >= 2;

create view vendor_switch_savings as
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
  coalesce(c.expected_next_cost, c.cost_per_base_unit) as current_cost,
  c.basis                                   as current_basis,
  b.vendor_name                             as cheapest_vendor,
  b.pack_description                        as cheapest_pack,
  coalesce(b.expected_next_cost, b.cost_per_base_unit) as cheapest_cost,
  b.basis                                   as cheapest_basis,
  b.quote_valid_through                     as cheapest_quote_valid_through,
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

alter view vendor_quotes_latest     set (security_invoker = true);
alter view forward_price_model      set (security_invoker = true);
alter view vendor_price_comparison  set (security_invoker = true);
alter view vendor_switch_savings    set (security_invoker = true);

-- ============================================================================
--  MIGRATION 0014 (20260906090000_beverage_distributor.sql, applied)
--  vendors.kind gains 'beverage_distributor' (Coca-Cola Beverages Northeast,
--  Pepsi bag-in-box tickets): product identity comes from the product row
--  (MAT# / UPC / flavor), never the "2.5 GALLO 1-Ls …" category header; a
--  2.5 gal BIB defaults to 320 fl oz (lib/core/packs.ts DEFAULT_PACKS, always
--  overridable); CO2 / gas cylinder lines are ignored as non-inventory.
--  Data fix: the learned header mapping → "Juice Drink" is removed and its
--  lines reset to unmapped for the re-parse + remap.
-- ============================================================================
alter table vendors drop constraint if exists vendors_kind_check;
alter table vendors add constraint vendors_kind_check check (kind in ('distributor','retail_liquor','beverage_distributor','other'));

-- ============================================================================
--  MIGRATION 0015 (20260906100000_catalog_health.sql, applied)
--  Catalog pruning: inventory_items.origin / first_invoiced_at / archived_at /
--  merged_into_id, the catalog_health view (confirmed | pending | orphan |
--  dormant | archived), merge_inventory_item(source, target), and
--  verification_queue excluding archived items. Full text below.
-- ============================================================================
-- 0015: catalog pruning — the invoice is the root (KICKOFF-3 item 3).
--  inventory_items.origin            invoice | recipe_draft | manual (how the row came to exist)
--  inventory_items.first_invoiced_at first time a posted invoice line mapped to it
--  inventory_items.archived_at       hidden from the verify queue and the daily
--                                    reconciliation; never deleted
--  inventory_items.merged_into_id    set by merge_inventory_item() on the source
--  catalog_health (view)             per item: origin, age, invoice evidence,
--                                    30-day recipe usage, and a status:
--                                    confirmed (has an invoice line) | pending
--                                    (draft-born, < 30 days) | orphan (draft-born,
--                                    >= 30 days, no invoice) | dormant (invoice-
--                                    born, no purchase in 90 days) | archived
--  merge_inventory_item(source, target) re-points recipes, invoice lines,
--                                    mappings, quotes and counts to the target,
--                                    drops the source's derived daily rows and
--                                    archives the source (history kept).
--  verification_queue excludes archived items.
alter table inventory_items
  add column if not exists origin text not null default 'manual',
  add column if not exists first_invoiced_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists merged_into_id uuid references inventory_items(id) on delete set null;
alter table inventory_items drop constraint if exists inventory_items_origin_check;
alter table inventory_items add constraint inventory_items_origin_check check (origin in ('invoice','recipe_draft','manual'));
create index if not exists inventory_items_archived_idx on inventory_items (tenant_id, archived_at);

-- Backfill: any item an invoice line has ever mapped to is invoice-born; everything else was drafted from the menu.
update inventory_items ii
   set origin = 'invoice',
       first_invoiced_at = coalesce(ii.first_invoiced_at, x.first_at)
  from (
    select l.inventory_item_id, min(coalesce(d.posted_at, l.created_at)) as first_at
      from invoice_lines l
      join invoice_documents d on d.id = l.invoice_id
     where l.inventory_item_id is not null
     group by 1
  ) x
 where x.inventory_item_id = ii.id;
update inventory_items set origin = 'recipe_draft' where origin = 'manual' and first_invoiced_at is null;

-- The merged "Juice Drink" item from the Coca-Cola header parse: kept as history, archived (no lines point at it any more).
update inventory_items set archived_at = now()
 where name = 'Juice Drink' and archived_at is null
   and not exists (select 1 from invoice_lines l where l.inventory_item_id = inventory_items.id)
   and not exists (select 1 from recipe_components r where r.inventory_item_id = inventory_items.id);

create or replace view catalog_health as
with posted_lines as (
  select l.inventory_item_id, count(*) as n, max(coalesce(d.received_date, d.invoice_date)) as last_received
    from invoice_lines l
    join invoice_documents d on d.id = l.invoice_id
   where l.inventory_item_id is not null
     and d.status = 'posted'
     and coalesce(d.document_kind, 'invoice') <> 'quote'
   group by 1
),
any_lines as (
  select inventory_item_id, count(*) as n from invoice_lines where inventory_item_id is not null group by 1
),
usage_30 as (
  select u.inventory_item_id, sum(u.quantity_used) as used_30d
    from usage_by_period u
   where u.business_date > current_date - 30
   group by 1
),
recipes as (
  select inventory_item_id, count(*) as n from recipe_components group by 1
)
select
  ii.tenant_id,
  ii.id                                        as inventory_item_id,
  ii.name,
  ii.category,
  ii.base_unit,
  ii.origin,
  ii.created_at,
  ii.first_invoiced_at,
  ii.archived_at,
  ii.merged_into_id,
  (current_date - ii.created_at::date)         as days_since_created,
  coalesce(al.n, 0) > 0                        as has_invoice_line,
  coalesce(pl.n, 0)                            as posted_line_count,
  pl.last_received                             as last_purchase_date,
  coalesce(r.n, 0)                             as recipe_count,
  coalesce(u.used_30d, 0)                      as recipe_usage_30d,
  case
    when ii.archived_at is not null then 'archived'
    when coalesce(al.n, 0) > 0 and pl.last_received is not null and pl.last_received < current_date - 90 then 'dormant'
    when coalesce(al.n, 0) > 0 then 'confirmed'
    when ii.created_at < now() - interval '30 days' then 'orphan'
    else 'pending'
  end                                          as status
from inventory_items ii
left join posted_lines pl on pl.inventory_item_id = ii.id
left join any_lines    al on al.inventory_item_id = ii.id
left join usage_30     u  on u.inventory_item_id = ii.id
left join recipes      r  on r.inventory_item_id = ii.id;
alter view catalog_health set (security_invoker = true);

create or replace function merge_inventory_item(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_target_tenant uuid;
begin
  if p_source = p_target then raise exception 'source and target are the same item'; end if;
  select tenant_id into v_tenant from inventory_items where id = p_source;
  select tenant_id into v_target_tenant from inventory_items where id = p_target;
  if v_tenant is null or v_target_tenant is null then raise exception 'item not found'; end if;
  if v_tenant <> v_target_tenant then raise exception 'items belong to different tenants'; end if;
  if auth.role() is distinct from 'service_role' and v_tenant not in (select my_tenant_ids()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- recipes: a menu item that already uses the target keeps the target's line
  delete from recipe_components s
   using recipe_components t
   where s.inventory_item_id = p_source and t.inventory_item_id = p_target and t.menu_item_id = s.menu_item_id;
  update recipe_components set inventory_item_id = p_target where inventory_item_id = p_source;

  update invoice_lines set inventory_item_id = p_target where inventory_item_id = p_source;
  update vendor_item_mappings set inventory_item_id = p_target where inventory_item_id = p_source;
  update vendor_quotes set inventory_item_id = p_target where inventory_item_id = p_source;

  -- counts: same day + position on both → the target's count stands
  delete from stock_counts s
   using stock_counts t
   where s.inventory_item_id = p_source and t.inventory_item_id = p_target
     and t.location_id = s.location_id and t.count_date = s.count_date and t.position = s.position;
  update stock_counts set inventory_item_id = p_target where inventory_item_id = p_source;

  -- derived rows: the nightly reconciliation recomputes (and restates) the target
  delete from daily_position where inventory_item_id = p_source;

  update inventory_items t
     set origin = case when t.origin = 'invoice' or s.origin = 'invoice' then 'invoice' else t.origin end,
         first_invoiced_at = least(coalesce(t.first_invoiced_at, s.first_invoiced_at), coalesce(s.first_invoiced_at, t.first_invoiced_at)),
         pack_to_base_factor = coalesce(t.pack_to_base_factor, s.pack_to_base_factor),
         cost_per_base_unit = coalesce(t.cost_per_base_unit, s.cost_per_base_unit)
    from inventory_items s
   where t.id = p_target and s.id = p_source;

  update inventory_items
     set archived_at = coalesce(archived_at, now()), merged_into_id = p_target
   where id = p_source;
end $$;
revoke all on function merge_inventory_item(uuid, uuid) from public;
grant execute on function merge_inventory_item(uuid, uuid) to authenticated, service_role;

-- verification_queue: archived items never come up for checking
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
  where ii.archived_at is null
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
alter view verification_queue set (security_invoker = true);
