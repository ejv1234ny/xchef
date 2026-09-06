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
