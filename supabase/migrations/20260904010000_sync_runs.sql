-- 0003: sync_runs log + Toast credential helpers backed by Supabase Vault.

-- ---------------------------------------------------------------------------
-- sync_runs: one row per toast-sync execution (architecture.md §6 ops note)
-- ---------------------------------------------------------------------------
create table sync_runs (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references locations(id) on delete cascade,
  kind             text not null default 'toast-sync',   -- 'toast-sync' | 'toast-backfill' | 'menu-sync'
  window_start     timestamptz,
  window_end       timestamptz,
  orders_fetched   int  not null default 0,
  orders_upserted  int  not null default 0,
  orders_quarantined int not null default 0,
  dates_rebuilt    date[] not null default '{}',
  duration_ms      int,
  error            text,
  created_at       timestamptz not null default now()
);
create index on sync_runs (location_id, created_at desc);

alter table sync_runs enable row level security;
create policy location_isolation on sync_runs for all
  using (location_id in (select my_location_ids())) with check (location_id in (select my_location_ids()));

-- ---------------------------------------------------------------------------
-- Toast credentials in Vault.
--   toast_credentials.client_secret_encrypted holds the vault secret's uuid,
--   never the secret itself. The web app (user JWT) may SET credentials for a
--   location it belongs to; only the service role may READ the secret back.
-- ---------------------------------------------------------------------------
create or replace function set_toast_credentials(
  p_location_id uuid,
  p_client_id   text,
  p_client_secret text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_secret_id uuid;
  v_existing  text;
begin
  -- Authorization: service role, or a member of the location's tenant.
  if auth.role() is distinct from 'service_role'
     and p_location_id not in (select my_location_ids()) then
    raise exception 'not authorized for location %', p_location_id using errcode = '42501';
  end if;

  select client_secret_encrypted into v_existing
  from toast_credentials where location_id = p_location_id;

  if v_existing is not null then
    v_secret_id := v_existing::uuid;
    perform vault.update_secret(v_secret_id, p_client_secret, 'toast:' || p_location_id::text,
                                'Toast client secret for location ' || p_location_id::text);
    update toast_credentials
       set client_id = p_client_id
     where location_id = p_location_id;
  else
    v_secret_id := vault.create_secret(p_client_secret, 'toast:' || p_location_id::text,
                                       'Toast client secret for location ' || p_location_id::text);
    insert into toast_credentials (location_id, client_id, client_secret_encrypted)
    values (p_location_id, p_client_id, v_secret_id::text);
  end if;
end $$;

revoke all on function set_toast_credentials(uuid, text, text) from public;
grant execute on function set_toast_credentials(uuid, text, text) to authenticated, service_role;

create or replace function get_toast_client_secret(p_location_id uuid)
returns text
language plpgsql security definer set search_path = public, vault as $$
declare
  v_secret text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role only' using errcode = '42501';
  end if;
  select ds.decrypted_secret into v_secret
  from toast_credentials tc
  join vault.decrypted_secrets ds on ds.id = tc.client_secret_encrypted::uuid
  where tc.location_id = p_location_id;
  return v_secret;
end $$;

revoke all on function get_toast_client_secret(uuid) from public;
grant execute on function get_toast_client_secret(uuid) to service_role;
