"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/db/context";
import { isAnthropicConfigured } from "@/lib/llm/anthropic";
import { runRecipeDraft } from "@/lib/jobs/recipeDraft";

const BATCH = 10;

function msg(kind: "ok" | "error", text: string): never {
  redirect(`/menu?${kind}=${encodeURIComponent(text)}`);
}

/** Draft recipes for the next 10 most-sold menu items that have none. */
export async function draftNextBatch() {
  const ctx = await getAppContext();
  if (!isAnthropicConfigured()) msg("error", "ANTHROPIC_API_KEY not configured");
  let result: Awaited<ReturnType<typeof runRecipeDraft>>;
  try {
    result = await runRecipeDraft({
      tenantId: ctx.tenant.id,
      locationId: ctx.location.id,
      limit: BATCH,
      onlyWithoutComponents: true,
      log: (m, meta) => console.log(JSON.stringify({ msg: m, ...meta })),
    });
  } catch (e) {
    msg("error", e instanceof Error ? e.message : String(e));
  }
  revalidatePath("/menu");
  revalidatePath("/recipes");
  revalidatePath("/inventory");
  if (result.drafted === 0 && result.errors === 0 && result.skipped === 0) msg("ok", "Nothing to draft: every item that sold in the last 30 days has a recipe");
  const parts = [`Drafted ${result.drafted}`];
  if (result.newItems) parts.push(`${result.newItems} new inventory items`);
  if (result.skipped) parts.push(`${result.skipped} came back empty`);
  if (result.errors) parts.push(`${result.errors} failed`);
  msg(result.errors && !result.drafted ? "error" : "ok", parts.join(" · ") + ". Confirm them in Recipe Q&A.");
}
