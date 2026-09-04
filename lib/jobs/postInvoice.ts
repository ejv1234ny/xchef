import type { ServiceClient } from "@/lib/db/service";

/**
 * Post job (architecture.md §4.3 step 5 + price refresh). A document posts
 * when every line is auto_mapped | confirmed | ignored and at least one line
 * is mapped; only then do its lines count in purchases_by_item. After posting,
 * inventory_items.cost_per_base_unit is set to the latest posted line's
 * cost_per_base_unit for each item on the document (simple last-price, read
 * from the item_price_history view — a select, not a recomputation).
 */
export type PostResult = "posted" | "needs_review" | "rejected" | "unchanged";

export async function postInvoiceIfResolved(svc: ServiceClient, documentId: string): Promise<PostResult> {
  const { data: doc, error } = await svc.from("invoice_documents").select("id, status").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);
  if (doc.status === "rejected") return "rejected";
  if (doc.status === "posted") return "unchanged";

  const { data: lines, error: lerr } = await svc.from("invoice_lines").select("status, inventory_item_id").eq("invoice_id", documentId);
  if (lerr) throw new Error(`read invoice_lines: ${lerr.message}`);
  const rows = lines ?? [];
  const isMapped = (s: string) => s === "auto_mapped" || s === "confirmed";
  const allResolved = rows.length > 0 && rows.every((l) => isMapped(l.status) || l.status === "ignored");
  const anyMapped = rows.some((l) => isMapped(l.status));

  if (!allResolved || !anyMapped) {
    if (doc.status !== "needs_review") await svc.from("invoice_documents").update({ status: "needs_review" }).eq("id", documentId);
    return "needs_review";
  }

  const { error: uerr } = await svc.from("invoice_documents").update({ status: "posted", posted_at: new Date().toISOString() }).eq("id", documentId);
  if (uerr) throw new Error(`post invoice_documents: ${uerr.message}`);

  const itemIds = [...new Set(rows.filter((l) => isMapped(l.status) && l.inventory_item_id).map((l) => l.inventory_item_id as string))];
  await refreshItemPrices(svc, itemIds, documentId);
  return "posted";
}

/**
 * inventory_items.cost_per_base_unit ← latest posted cost per base unit.
 * Ordered by coalesce(received_date, invoice_date) desc (the view's
 * received_date); ties go to the document just posted.
 */
export async function refreshItemPrices(svc: ServiceClient, itemIds: string[], preferInvoiceId?: string): Promise<number> {
  let updated = 0;
  for (const itemId of itemIds) {
    const { data: hist, error } = await svc
      .from("item_price_history")
      .select("cost_per_base_unit, received_date, invoice_id")
      .eq("inventory_item_id", itemId)
      .not("cost_per_base_unit", "is", null)
      .order("received_date", { ascending: false, nullsFirst: false })
      .limit(25);
    if (error) throw new Error(`read item_price_history: ${error.message}`);
    if (!hist || hist.length === 0) continue;
    const top = hist[0].received_date;
    const ties = hist.filter((h) => h.received_date === top);
    const pick = ties.find((h) => h.invoice_id === preferInvoiceId) ?? ties[0];
    if (pick.cost_per_base_unit == null) continue;
    const { error: uerr } = await svc.from("inventory_items").update({ cost_per_base_unit: Number(Number(pick.cost_per_base_unit).toFixed(4)) }).eq("id", itemId);
    if (uerr) throw new Error(`update inventory_items ${itemId}: ${uerr.message}`);
    updated += 1;
  }
  return updated;
}
