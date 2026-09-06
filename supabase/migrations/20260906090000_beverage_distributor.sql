-- 0014: beverage distributors (Coca-Cola Beverages Northeast bag-in-box tickets).
--  vendors.kind gains 'beverage_distributor': product identity comes from the
--  product line (MAT# / UPC / flavor), never from the "2.5 GALLO 1-Ls JUICE DRI"
--  category header; a 2.5 gal BIB is 320 fl oz by default (lib/core/packs.ts);
--  CO2 cylinders are ignored as non-inventory (gas is not tracked).
--  Data fix: the learned mapping that pointed the category header text at the
--  merged "Juice Drink" item is removed and its lines are reset to unmapped so
--  the re-parse + remap lands each line on its real product. The "Juice Drink"
--  item itself is kept (history) and archived by migration 0015.
alter table vendors drop constraint if exists vendors_kind_check;
alter table vendors add constraint vendors_kind_check check (kind in ('distributor','retail_liquor','beverage_distributor','other'));

update vendors set kind = 'beverage_distributor' where lower(name) like '%coca%cola%' or lower(name) like '%pepsi%';

update invoice_lines l
   set status = 'unmapped', mapping_id = null, inventory_item_id = null, quantity_base_unit = null, cost_per_base_unit = null
  from vendor_item_mappings m
 where m.id = l.mapping_id
   and m.description_norm like '2.5 gallo 1 ls%';

delete from vendor_item_mappings where description_norm like '2.5 gallo 1 ls%';
