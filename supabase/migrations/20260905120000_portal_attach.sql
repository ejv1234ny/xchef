-- 0012: vendor-portal pull (fifth intake channel, source = 'api').
--  invoice_documents.clean_storage_path      the authoritative copy pulled from the
--                                            vendor portal, attached to the document
--                                            that first arrived as paper/photo
--  invoice_documents.verified_by_clean_copy_at  set when the clean copy's line totals
--                                            matched the posted lines within one cent
--  invoice_documents.parse_diff              "paper said / portal says" when they differ
--  invoice_documents.document_kind           invoice | credit | statement | other | quote
alter table invoice_documents
  add column if not exists clean_storage_path text,
  add column if not exists verified_by_clean_copy_at timestamptz,
  add column if not exists parse_diff jsonb,
  add column if not exists document_kind text;
create index if not exists invoice_documents_vendor_invoice_number_idx on invoice_documents (vendor_id, invoice_number);
