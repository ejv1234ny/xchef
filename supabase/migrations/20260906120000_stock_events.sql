-- 0017: 86-list from Toast Stock (GET /stock/v1/inventory, scope stock:read) — KICKOFF-3 item 5.
--  menu_item_stock_events   appended by the 5-minute toast-sync when a menu item's
--                           stock status (or its QUANTITY count) differs from the
--                           last observed row: events, not snapshots. Toast lists
--                           only OUT_OF_STOCK / QUANTITY items; an item that drops
--                           off the list is recorded as IN_STOCK again.
--  menu_item_stock_latest   current status per menu item (latest event)
--  ingredient_stockouts     per ingredient: its top menu item by 30-day units sold,
--                           when that item is currently OUT_OF_STOCK ("86'd since …")
--  daily_position.stockout_minutes  minutes of the business day the ingredient's
--                           menu items were 86'd, so a low-usage day reads as
--                           explained rather than as variance
create table menu_item_stock_events (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references locations(id) on delete cascade,
  toast_menu_item_guid  text not null,
  status                text not null check (status in ('IN_STOCK','OUT_OF_STOCK','QUANTITY')),
  quantity              numeric(12,2),
  observed_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);
create index on menu_item_stock_events (location_id, toast_menu_item_guid, observed_at desc);
create index on menu_item_stock_events (location_id, observed_at desc);
alter table menu_item_stock_events enable row level security;
create policy location_isolation on menu_item_stock_events for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

create or replace view menu_item_stock_latest as
select distinct on (e.location_id, e.toast_menu_item_guid)
  e.location_id,
  e.toast_menu_item_guid,
  mi.id                 as menu_item_id,
  mi.name               as menu_item_name,
  e.status,
  e.quantity,
  e.observed_at
from menu_item_stock_events e
join locations loc on loc.id = e.location_id
left join menu_items mi on mi.tenant_id = loc.tenant_id and mi.toast_menu_item_guid = e.toast_menu_item_guid
order by e.location_id, e.toast_menu_item_guid, e.observed_at desc;
alter view menu_item_stock_latest set (security_invoker = true);

create or replace view ingredient_stockouts as
with sold as (
  select s.location_id, s.menu_item_id, sum(s.quantity_sold) as units_30d
    from sales_facts s
   where s.business_date > current_date - 30 and s.menu_item_id is not null
   group by 1, 2
),
top_item as (
  select rc.inventory_item_id,
         loc.id                       as location_id,
         mi.id                        as menu_item_id,
         mi.name                      as menu_item_name,
         mi.toast_menu_item_guid,
         coalesce(sd.units_30d, 0)    as units_30d,
         row_number() over (partition by loc.id, rc.inventory_item_id order by coalesce(sd.units_30d, 0) desc, mi.name) as rn
    from recipe_components rc
    join menu_items mi on mi.id = rc.menu_item_id
    join locations loc on loc.tenant_id = mi.tenant_id
    left join sold sd on sd.location_id = loc.id and sd.menu_item_id = mi.id
   where mi.toast_menu_item_guid is not null
)
select t.location_id, t.inventory_item_id, t.menu_item_id, t.menu_item_name, t.units_30d, l.status, l.quantity, l.observed_at as since
  from top_item t
  join menu_item_stock_latest l on l.location_id = t.location_id and l.toast_menu_item_guid = t.toast_menu_item_guid
 where t.rn = 1 and l.status = 'OUT_OF_STOCK';
alter view ingredient_stockouts set (security_invoker = true);

alter table daily_position add column if not exists stockout_minutes int not null default 0;
