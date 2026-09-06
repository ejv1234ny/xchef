-- 0018: labor beside pour cost (KICKOFF-3 item 6).
--  labor_entries       one row per Toast time entry (GET /labor/v1/timeEntries,
--                      scope labor:read; no employee details beyond the guid and
--                      the job title), synced daily by /api/cron/daily-sync with a
--                      36-hour re-pull window, backfilled 90 days.
--  daily_labor (view)  per location × business date: hours, labor cost
--                      (regular × wage + overtime × wage × 1.5), tips
--  daily_cost_summary  per location × business date: net sales, theoretical
--  (view)              usage cost (pour / food cost), labor cost, both as % of
--                      net sales — the two cost lines on /position
create table labor_entries (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references locations(id) on delete cascade,
  toast_guid       text not null,
  employee_guid    text,
  job_guid         text,
  job_title        text,
  business_date    date not null,
  clock_in         timestamptz,
  clock_out        timestamptz,
  regular_hours    numeric(10,4) not null default 0,
  overtime_hours   numeric(10,4) not null default 0,
  wage             numeric(12,4),
  tips_declared    numeric(12,2),
  cash_tips        numeric(12,2),
  non_cash_tips    numeric(12,2),
  deleted          boolean not null default false,
  toast_modified_at timestamptz,
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (location_id, toast_guid)
);
create index on labor_entries (location_id, business_date);
alter table labor_entries enable row level security;
create policy location_isolation on labor_entries for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

create or replace view daily_labor as
select
  location_id,
  business_date,
  count(*)                                                        as entries,
  count(distinct employee_guid)                                   as employees,
  sum(regular_hours + overtime_hours)                             as hours,
  sum(regular_hours)                                              as regular_hours,
  sum(overtime_hours)                                             as overtime_hours,
  sum(regular_hours * coalesce(wage, 0) + overtime_hours * coalesce(wage, 0) * 1.5) as labor_cost,
  sum(coalesce(tips_declared, 0) + coalesce(cash_tips, 0) + coalesce(non_cash_tips, 0)) as tips
from labor_entries
where not deleted
group by 1, 2;
alter view daily_labor set (security_invoker = true);

create or replace view daily_cost_summary as
with sales as (
  select location_id, business_date, sum(net_sales) as net_sales, sum(quantity_sold) as units_sold
    from sales_facts group by 1, 2
),
usage as (
  select location_id, business_date, sum(usage_cost) as usage_cost
    from usage_by_period group by 1, 2
),
dates as (
  select location_id, business_date from sales
  union select location_id, business_date from usage
  union select location_id, business_date from daily_labor
)
select
  d.location_id,
  d.business_date,
  coalesce(s.net_sales, 0)                    as net_sales,
  coalesce(s.units_sold, 0)                   as units_sold,
  coalesce(u.usage_cost, 0)                   as usage_cost,
  coalesce(l.hours, 0)                        as labor_hours,
  coalesce(l.labor_cost, 0)                   as labor_cost,
  coalesce(l.tips, 0)                         as tips,
  case when coalesce(s.net_sales, 0) > 0 then coalesce(u.usage_cost, 0) / s.net_sales end as usage_pct,
  case when coalesce(s.net_sales, 0) > 0 then coalesce(l.labor_cost, 0) / s.net_sales end as labor_pct
from dates d
left join sales s on s.location_id = d.location_id and s.business_date = d.business_date
left join usage u on u.location_id = d.location_id and u.business_date = d.business_date
left join daily_labor l on l.location_id = d.location_id and l.business_date = d.business_date;
alter view daily_cost_summary set (security_invoker = true);
