-- ============================================================================
--  xchef — Usage-Tracking Schema (Supabase / Postgres) — ANNOTATED
--  The exact SQL applied to xchef-dev lives in supabase/migrations/0001_init.sql
--  (identical DDL, comments stripped) and 0002_rls.sql. Edit here, then cut a
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
--  ROW-LEVEL SECURITY: see supabase/migrations/0002_rls.sql (applied).
--  Every table is scoped to the caller's memberships; views run as invoker.
--  Cron and inbound routes use the service-role key and bypass RLS.
-- ----------------------------------------------------------------------------
