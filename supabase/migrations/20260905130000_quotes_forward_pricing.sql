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
