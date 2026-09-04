import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createManualInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";
import { authenticateIntake, errorResponse, isResponse } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Money = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

const Body = z.object({
  vendorName: z.string().trim().min(1).max(120),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invoiceDate must be YYYY-MM-DD"),
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        vendor_sku: z.string().trim().max(60).nullable().optional(),
        pack_size_text: z.string().trim().max(60).nullable().optional(),
        quantity: Money,
        unit_price: Money.nullable().optional(),
        extended_price: Money.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/** POST JSON { vendorName, invoiceDate, invoiceNumber?, lines[] } → document with lines (source 'manual', no parsing) → map → post. */
export async function POST(request: NextRequest) {
  const auth = await authenticateIntake();
  if (isResponse(auth)) return auth;
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.issues }, { status: 400 });
    const body = parsed.data;
    const created = await createManualInvoiceDocument(auth.svc, {
      locationId: auth.locationId,
      source: "manual",
      vendorName: body.vendorName,
      invoiceDate: body.invoiceDate,
      invoiceNumber: body.invoiceNumber ?? null,
      lines: body.lines.map((l) => ({
        description: l.description,
        vendor_sku: l.vendor_sku ?? null,
        pack_size_text: l.pack_size_text ?? null,
        quantity: l.quantity,
        unit_price: l.unit_price ?? null,
        extended_price: l.extended_price ?? (l.unit_price != null ? Number(l.unit_price) * Number(l.quantity) : null),
      })),
      meta: { source: "manual", enteredBy: auth.userId, lines: body.lines },
    });
    const result = await runInvoicePipeline(auth.svc, created.documentId, { log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })) });
    return NextResponse.json({ documentId: created.documentId, status: result.status, duplicate: created.duplicate, lines: result.lines, mapped: result.mapped, unmapped: result.unmapped });
  } catch (e) {
    console.error("intake/manual failed", e);
    return errorResponse(e);
  }
}
