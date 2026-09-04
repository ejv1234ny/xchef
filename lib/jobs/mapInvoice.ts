import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Tables } from "@/lib/db/types";
import { isAnthropicConfigured, logLlmCall, MODELS } from "@/lib/llm/anthropic";
import { matchSku } from "@/lib/llm/sku-match";
import { computeLineTotals, resolveLine, type InventoryRef, type LineInput, type MappingRef, type Resolution, type SkuMatch } from "@/lib/core/resolveMapping";
import { isUom } from "@/lib/core/units";
import { getLocation, type Logger } from "./intake";

/** The post step lives in postInvoice.ts; re-exported here because the UI imports both from this module. */
export { postInvoiceIfResolved, type PostResult } from "./postInvoice";

/**
 * Map job (architecture.md §4.3 steps 1–4). For every line that is not
 * human-resolved: saved SKU mapping → saved description mapping → fee/deposit
 * → Haiku sku-match (only when the API is configured). A high-confidence AI
 * match creates an unconfirmed vendor_item_mappings row so the next invoice
 * from that vendor maps without asking.
 *
 *  - 'confirmed' and 'ignored' lines are never overwritten. A 'confirmed' line
 *    whose totals are missing (the UI set mapping_id + confirmed) gets its
 *    quantity_base_unit / cost_per_base_unit filled from its mapping.
 *  - Lines left 'unmapped' keep the AI's suggested inventory_item_id (status
 *    stays unmapped, so views ignore it); the full suggestion is in llm_calls
 *    (kind 'sku-match', ref_id = line id).
 */
export type MapResult = { mapped: number; unmapped: number; ignored: number };

const num = (s: string | null): number | null => (s == null ? null : Number(new Decimal(s).toFixed(6)));

function toLineInput(l: Tables<"invoice_lines">): LineInput {
  return {
    id: l.id,
    vendor_sku: l.vendor_sku,
    description: l.description,
    pack_size_text: l.pack_size_text,
    quantity: String(l.quantity),
    unit_price: l.unit_price == null ? null : String(l.unit_price),
    extended_price: l.extended_price == null ? null : String(l.extended_price),
    ai_category_guess: l.ai_category_guess,
  };
}

async function ensureMapping(
  svc: ServiceClient,
  tenantId: string,
  vendorId: string,
  inventoryItemId: string,
  proposal: NonNullable<Resolution["proposed_mapping"]>,
): Promise<string | null> {
  const { data, error } = await svc
    .from("vendor_item_mappings")
    .insert({
      tenant_id: tenantId,
      vendor_id: vendorId,
      vendor_sku: proposal.vendor_sku,
      description_norm: proposal.description_norm,
      inventory_item_id: inventoryItemId,
      units_per_pack: Number(proposal.units_per_pack),
      base_units_per_unit: Number(proposal.base_units_per_unit),
      brand: proposal.brand,
      pack_description: proposal.pack_description,
      confirmed_at: null,
    })
    .select("id")
    .single();
  if (!error) return data.id;
  // unique (vendor_id, vendor_sku) / (vendor_id, description_norm) — someone got there first; reuse it
  if (proposal.vendor_sku) {
    const { data: bySku } = await svc.from("vendor_item_mappings").select("id").eq("vendor_id", vendorId).eq("vendor_sku", proposal.vendor_sku).maybeSingle();
    if (bySku) return bySku.id;
  }
  const { data: byDesc } = await svc.from("vendor_item_mappings").select("id").eq("vendor_id", vendorId).eq("description_norm", proposal.description_norm).maybeSingle();
  return byDesc?.id ?? null;
}

export async function mapInvoiceDocument(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<MapResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("id, location_id, vendor_id, status, raw_extraction").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const location = await getLocation(svc, doc.location_id);

  const { data: lineRows, error: lerr } = await svc.from("invoice_lines").select("*").eq("invoice_id", documentId).order("line_no");
  if (lerr) throw new Error(`read invoice_lines: ${lerr.message}`);
  const lines = lineRows ?? [];
  const result: MapResult = { mapped: 0, unmapped: 0, ignored: 0 };
  const tally = (status: Tables<"invoice_lines">["status"]) => {
    if (status === "auto_mapped" || status === "confirmed") result.mapped += 1;
    else if (status === "ignored") result.ignored += 1;
    else result.unmapped += 1;
  };

  if (!doc.vendor_id) {
    lines.forEach((l) => tally(l.status));
    log("invoice-map: no vendor on document, nothing to map", { documentId });
    return result;
  }
  const vendorId = doc.vendor_id;

  const [{ data: mappingRows, error: merr }, { data: inventoryRows, error: ierr }, { data: vendorRow }] = await Promise.all([
    svc.from("vendor_item_mappings").select("id, vendor_id, vendor_sku, description_norm, inventory_item_id, units_per_pack, base_units_per_unit, confirmed_at").eq("vendor_id", vendorId),
    svc.from("inventory_items").select("id, name, category, base_unit, pack_to_base_factor").eq("tenant_id", location.tenant_id).order("name"),
    svc.from("vendors").select("name").eq("id", vendorId).maybeSingle(),
  ]);
  if (merr) throw new Error(`read vendor_item_mappings: ${merr.message}`);
  if (ierr) throw new Error(`read inventory_items: ${ierr.message}`);
  const mappings: MappingRef[] = mappingRows ?? [];
  const inventoryFull = inventoryRows ?? [];
  const inventory: InventoryRef[] = inventoryFull.filter((i) => isUom(i.base_unit)).map((i) => ({ id: i.id, name: i.name, base_unit: i.base_unit, pack_to_base_factor: i.pack_to_base_factor }));
  const vendorName = vendorRow?.name ?? "vendor";
  const llmOk = isAnthropicConfigured();

  for (const line of lines) {
    if (line.status === "ignored") {
      tally("ignored");
      continue;
    }
    if (line.status === "confirmed") {
      if (line.quantity_base_unit == null && line.mapping_id) {
        const m = mappings.find((x) => x.id === line.mapping_id);
        if (m) {
          const totals = computeLineTotals(toLineInput(line), new Decimal(m.units_per_pack), new Decimal(m.base_units_per_unit), false);
          await svc
            .from("invoice_lines")
            .update({ inventory_item_id: m.inventory_item_id, quantity_base_unit: num(totals.quantity_base_unit), cost_per_base_unit: num(totals.cost_per_base_unit) })
            .eq("id", line.id);
        }
      }
      tally("confirmed");
      continue;
    }

    const input = toLineInput(line);
    let r = resolveLine({ line: input, vendorId, mappings, inventory });

    if (r.status === "unmapped" && llmOk) {
      let sm: SkuMatch | null = null;
      try {
        const res = await matchSku({
          line: {
            description: input.description,
            vendor_sku: input.vendor_sku,
            pack_size_text: input.pack_size_text,
            unit_price: input.unit_price,
            extended_price: input.extended_price,
            quantity: input.quantity,
            category_guess: input.ai_category_guess,
          },
          vendorName,
          inventory: inventoryFull,
        });
        sm = res.data;
        await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "sku-match", ref_id: line.id, model: MODELS.haiku, usage: res.usage, raw: res.raw });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "sku-match", ref_id: line.id, model: MODELS.haiku, error: msg });
        log("invoice-map: sku-match failed", { lineId: line.id, error: msg });
      }
      if (sm) r = resolveLine({ line: input, vendorId, mappings, inventory, skuMatch: sm });
    }

    let mappingId = r.mapping_id;
    if (r.status === "auto_mapped" && !mappingId && r.proposed_mapping && r.inventory_item_id) {
      mappingId = await ensureMapping(svc, location.tenant_id, vendorId, r.inventory_item_id, r.proposed_mapping);
      if (mappingId) {
        mappings.push({
          id: mappingId,
          vendor_id: vendorId,
          vendor_sku: r.proposed_mapping.vendor_sku,
          description_norm: r.proposed_mapping.description_norm,
          inventory_item_id: r.inventory_item_id,
          units_per_pack: Number(r.proposed_mapping.units_per_pack),
          base_units_per_unit: Number(r.proposed_mapping.base_units_per_unit),
          confirmed_at: null,
        });
      }
    }

    const { error: uerr } = await svc
      .from("invoice_lines")
      .update({
        status: r.status,
        inventory_item_id: r.inventory_item_id,
        mapping_id: r.status === "auto_mapped" ? mappingId : null,
        quantity_base_unit: r.status === "auto_mapped" ? num(r.quantity_base_unit) : null,
        cost_per_base_unit: r.status === "auto_mapped" ? num(r.cost_per_base_unit) : null,
      })
      .eq("id", line.id);
    if (uerr) throw new Error(`update invoice_lines ${line.id}: ${uerr.message}`);
    tally(r.status);
    log("invoice-map: line", { lineId: line.id, line_no: line.line_no, status: r.status, pack: r.pack_source, assumed: r.assumed_text, reason: r.reason });
  }
  return result;
}
