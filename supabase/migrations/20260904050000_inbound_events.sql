-- 0007: inbound_events — one row per inbound email webhook delivery (Resend,
-- and Postmark while it is still wired), whether or not a document was
-- created, so "what arrived?" is answerable without provider dashboards.
create table inbound_events (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid references locations(id) on delete set null,
  provider           text not null,                  -- 'resend' | 'postmark'
  event_type         text not null,                  -- 'email.received', ...
  email_id           text,                           -- provider's email id
  message_id         text,                           -- RFC 5322 Message-ID
  from_address       text,
  to_addresses       text[] not null default '{}',
  subject            text,
  attachment_count   int  not null default 0,
  documents_created  int  not null default 0,
  document_ids       uuid[] not null default '{}',
  error              text,
  created_at         timestamptz not null default now()
);
create index on inbound_events (created_at desc);
create index on inbound_events (email_id);
create index on inbound_events (message_id);

alter table inbound_events enable row level security;
-- Readable by members of the location's tenant; only the service role writes.
create policy location_read on inbound_events for select
  using (location_id in (select my_location_ids()));
