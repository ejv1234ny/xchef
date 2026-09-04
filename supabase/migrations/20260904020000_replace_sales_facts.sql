-- 0004: atomic sales_facts rebuild for a set of business dates, callable from
-- the service-role client (one RPC == one transaction; supabase-js has no
-- client-side transactions). Also relinks sales_facts.menu_item_id after a
-- menu sync so earlier sales pick up newly synced menu items.

create or replace function replace_sales_facts(p_location_id uuid, p_dates date[], p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'service role only' using errcode = '42501';
  end if;
  select tenant_id into v_tenant from locations where id = p_location_id;
  if v_tenant is null then
    raise exception 'unknown location %', p_location_id;
  end if;

  delete from sales_facts
   where location_id = p_location_id and business_date = any (p_dates);

  insert into sales_facts (location_id, menu_item_id, toast_menu_item_guid, business_date,
                           quantity_sold, quantity_voided, net_sales, synced_at)
  select p_location_id, mi.id, r.guid, r.business_date,
         r.quantity_sold, r.quantity_voided, r.net_sales, now()
  from jsonb_to_recordset(p_rows)
         as r(guid text, business_date date, quantity_sold numeric, quantity_voided numeric, net_sales numeric)
  left join menu_items mi on mi.tenant_id = v_tenant and mi.toast_menu_item_guid = r.guid
  where r.business_date = any (p_dates);

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function replace_sales_facts(uuid, date[], jsonb) from public;
grant execute on function replace_sales_facts(uuid, date[], jsonb) to service_role;

create or replace function relink_sales_facts(p_location_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'service role only' using errcode = '42501';
  end if;
  select tenant_id into v_tenant from locations where id = p_location_id;
  update sales_facts s
     set menu_item_id = mi.id
    from menu_items mi
   where s.location_id = p_location_id
     and s.menu_item_id is null
     and mi.tenant_id = v_tenant
     and mi.toast_menu_item_guid = s.toast_menu_item_guid;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function relink_sales_facts(uuid) from public;
grant execute on function relink_sales_facts(uuid) to service_role;
