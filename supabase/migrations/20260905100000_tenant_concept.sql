-- 0010: tenants.concept — the one-sentence description of the operation used
-- as recipe-drafting context (was hardcoded to Mad Moose in recipe-draft.ts).
alter table tenants add column if not exists concept text;
update tenants set concept = 'a bar & grill in Vermont (burgers, wings, sandwiches, salads, pub entrees, draft and canned beer, wine by the glass, classic cocktails and shots)'
 where name = 'Mad Moose' and concept is null;
