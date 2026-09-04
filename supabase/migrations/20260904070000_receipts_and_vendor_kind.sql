-- 0009: multi-receipt scans and retail liquor receipts.
--  vendors.kind: distributor (default) | retail_liquor | other.
--  invoice_documents: receipt_id (the unique printed number — barcode / receipt
--  number, else invoice number), transaction_code (non-unique register/store
--  codes such as "2017-2017-1-176"), invoice_time, printed_item_count ("Total
--  Sales Quantity 15"). Dedupe: unique (vendor_id, receipt_id); when receipt_id
--  is null, unique (vendor_id, invoice_date, invoice_time, total).
--  invoice_lines: gross_price + adjustment (discount/promo/deposit/credit that
--  belongs to the preceding item; extended_price = gross − adjustment) and
--  pack_size_assumed (retail liquor: bottle size inferred/defaulted to 750 ml).
alter table vendors add column if not exists kind text not null default 'distributor';
alter table vendors add constraint vendors_kind_check check (kind in ('distributor','retail_liquor','other'));

alter table invoice_documents
  add column if not exists receipt_id text,
  add column if not exists transaction_code text,
  add column if not exists invoice_time time,
  add column if not exists printed_item_count int;

create unique index if not exists invoice_documents_vendor_receipt_uidx
  on invoice_documents (vendor_id, receipt_id)
  where receipt_id is not null and vendor_id is not null;
create unique index if not exists invoice_documents_vendor_datetime_total_uidx
  on invoice_documents (vendor_id, invoice_date, invoice_time, total)
  where receipt_id is null and vendor_id is not null and invoice_date is not null and invoice_time is not null and total is not null;

alter table invoice_lines
  add column if not exists gross_price numeric(12,2),
  add column if not exists adjustment numeric(12,2),
  add column if not exists pack_size_assumed boolean not null default false;

update vendors set kind = 'retail_liquor' where lower(name) like '%802 spirits%';
