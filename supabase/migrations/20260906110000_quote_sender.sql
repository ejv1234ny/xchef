-- 0016: quote sender identity (KICKOFF-3 item 4).
--  tenants.owner_first_name      signs outbound quote requests ("Thanks, Eric / Mad Moose Bar & Grill")
--  quote_requests.status         gains 'blocked_sender': the request was composed
--                                but held because the restaurant's sending domain
--                                (RESEND_FROM_DOMAIN) is not verified in Resend —
--                                nothing goes out from another venture's domain
--  quote_requests.note           why it was held (DNS records pending, …)
alter table tenants add column if not exists owner_first_name text;
update tenants set owner_first_name = 'Eric' where name = 'Mad Moose' and owner_first_name is null;

alter table quote_requests drop constraint if exists quote_requests_status_check;
alter table quote_requests add constraint quote_requests_status_check check (status in ('sent','replied','no_reply','blocked_sender'));
alter table quote_requests add column if not exists note text;
