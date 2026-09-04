"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppContext } from "@/lib/db/context";
import { createServiceSupabase } from "@/lib/db/service";
import { createInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";

function msg(kind: "ok" | "error", text: string): never {
  redirect(`/invoices?${kind}=${encodeURIComponent(text)}`);
}

const pasteSchema = z.object({
  text: z.string().trim().min(20, "Paste the whole invoice — at least a vendor name and a few lines"),
});

/**
 * Pasted invoice text becomes an invoice_documents row (source='paste') and goes
 * through the same parse → map → post pipeline as a photo. The pipeline runs with
 * the service role because it writes Storage and llm_calls; the location comes
 * from the signed-in user's context, never from the form.
 */
export async function pasteInvoice(formData: FormData) {
  const ctx = await getAppContext();
  const parsed = pasteSchema.safeParse({ text: formData.get("text") });
  if (!parsed.success) msg("error", parsed.error.issues[0]?.message ?? "Nothing to paste");

  const svc = createServiceSupabase();
  let documentId: string;
  let duplicate = false;
  try {
    const created = await createInvoiceDocument(svc, {
      locationId: ctx.location.id,
      source: "paste",
      text: parsed.data.text,
      mimeType: "text/plain",
      filename: "paste.txt",
    });
    documentId = created.documentId;
    duplicate = created.duplicate;
    if (!duplicate) await runInvoicePipeline(svc, documentId);
  } catch (e) {
    msg("error", e instanceof Error ? e.message : "Could not read the pasted text");
  }
  revalidatePath("/invoices");
  redirect(`/invoices/review/${documentId}${duplicate ? "?ok=" + encodeURIComponent("Already on file — showing the existing invoice") : ""}`);
}
