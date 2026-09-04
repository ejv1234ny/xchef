-- 0006: vendor_sheet_layouts — learned column maps for spreadsheet invoices
-- (csv/tsv/xlsx/xls). Keyed by a fingerprint of the normalized header row so
-- the same export layout never asks Haiku (or a human) twice.
create table vendor_sheet_layouts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  vendor_id           uuid references vendors(id) on delete set null,
  header_fingerprint  text not null,                 -- sha256 of normalized header cells joined by '|'
  header_cells        text[] not null default '{}',  -- the header row as seen, for display
  column_map          jsonb not null,                -- { "<column index>": role } roles: vendor_sku|description|pack_size|quantity|unit_price|extended_price|invoice_number|invoice_date|vendor_name|ignore
  source              text not null default 'ai',    -- 'builtin' | 'ai' | 'heuristic' | 'human'
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
