-- 0019: Supabase security advisor after KICKOFF-3 migrations.
--  purchases_by_item and item_price_history were re-created by migration 0013
--  (quotes) without security_invoker, so they ran as their creator instead of
--  the querying user (advisor ERROR security_definer_view). Restored here;
--  every other view already has it. merge_inventory_item() must never be
--  callable anonymously (it checks membership itself for signed-in users).
alter view purchases_by_item   set (security_invoker = true);
alter view item_price_history  set (security_invoker = true);
revoke execute on function merge_inventory_item(uuid, uuid) from anon;
