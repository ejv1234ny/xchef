-- 0005: audit log for every Claude call (recipe drafts, invoice parses, SKU matches).
create table llm_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  kind           text not null,                 -- 'recipe-draft' | 'invoice-parse' | 'sku-match'
  ref_id         uuid,                          -- menu_item_id / invoice_document_id / invoice_line_id
  model          text not null,
  input_tokens   int  not null default 0,
  output_tokens  int  not null default 0,
  cost_usd       numeric(10,6),
  raw            jsonb,
  error          text,
  created_at     timestamptz not null default now()
);
create index on llm_calls (tenant_id, kind, created_at desc);
create index on llm_calls (ref_id);
alter table llm_calls enable row level security;
create policy tenant_isolation on llm_calls for all
  using (tenant_id in (select my_tenant_ids())) with check (tenant_id in (select my_tenant_ids()));
