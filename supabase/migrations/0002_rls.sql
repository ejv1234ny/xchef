-- Row-level security: every table scoped to the caller's memberships.
-- Service-role (cron, inbound webhook) bypasses RLS by design.
-- Applied to xchef-dev on 2026-09-04 via Supabase MCP.

create or replace function my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from memberships where user_id = auth.uid()
$$;

create or replace function my_location_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select l.id from locations l where l.tenant_id in (select my_tenant_ids())
$$;

alter table memberships enable row level security;
create policy own_membership on memberships for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table tenants enable row level security;
create policy tenant_isolation on tenants for all
  using (id in (select my_tenant_ids())) with check (id in (select my_tenant_ids()));

alter table locations enable row level security;
create policy tenant_isolation on locations for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

alter table inventory_items enable row level security;
create policy tenant_isolation on inventory_items for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

alter table menu_items enable row level security;
create policy tenant_isolation on menu_items for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

alter table vendors enable row level security;
create policy tenant_isolation on vendors for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

alter table vendor_item_mappings enable row level security;
create policy tenant_isolation on vendor_item_mappings for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));

alter table recipe_components enable row level security;
create policy tenant_isolation on recipe_components for all
  using (menu_item_id in (select id from menu_items where tenant_id in (select my_tenant_ids())))
  with check (menu_item_id in (select id from menu_items where tenant_id in (select my_tenant_ids())));

alter table toast_credentials enable row level security;
create policy location_isolation on toast_credentials for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

alter table toast_orders_raw enable row level security;
create policy location_isolation on toast_orders_raw for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

alter table sales_facts enable row level security;
create policy location_isolation on sales_facts for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

alter table invoice_documents enable row level security;
create policy location_isolation on invoice_documents for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

alter table invoice_lines enable row level security;
create policy location_isolation on invoice_lines for all
  using (invoice_id in (select id from invoice_documents where location_id in (select my_location_ids())))
  with check (invoice_id in (select id from invoice_documents where location_id in (select my_location_ids())));

alter table stock_counts enable row level security;
create policy location_isolation on stock_counts for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

-- Views must run as the caller so RLS applies through them.
alter view purchases_by_item        set (security_invoker = true);
alter view item_price_history       set (security_invoker = true);
alter view unit_cogs_master         set (security_invoker = true);
alter view vendor_price_latest      set (security_invoker = true);
alter view vendor_price_comparison  set (security_invoker = true);
alter view vendor_switch_savings    set (security_invoker = true);
alter view usage_by_period          set (security_invoker = true);
alter view usage_by_menu_item       set (security_invoker = true);
alter view menu_item_cost           set (security_invoker = true);
alter view on_hand_estimate         set (security_invoker = true);
alter view count_variance           set (security_invoker = true);
alter view verification_queue       set (security_invoker = true);
