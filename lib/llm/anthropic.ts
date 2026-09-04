import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { env } from "@/lib/env";
import type { ServiceClient } from "@/lib/db/service";
import type { Json } from "@/lib/db/types";

/** Pinned model ids. Change here only, with a note in the commit message. */
export const MODELS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;

/** USD per million tokens, for the cost log only (not billing). */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  [MODELS.sonnet]: { input: 2, output: 10 },
  [MODELS.haiku]: { input: 1, output: 5 },
};

let client: Anthropic | undefined;
export function getAnthropic(): Anthropic {
  if (!client) {
    // Identity-linked API keys must name the workspace they act in.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic({
      apiKey: env.anthropicApiKey(),
      defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
    });
  }
  return client;
}

export function isAnthropicConfigured(): boolean {
  return env.has("ANTHROPIC_API_KEY");
}

export type ToolCallResult<T> = {
  data: T;
  raw: Anthropic.Message;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
};

export function costUsd(model: string, input: number, output: number): number {
  const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0 };
  return (input * p.input + output * p.output) / 1_000_000;
}

/**
 * One forced tool-use call, temperature 0, output validated with zod. Every
 * caller stores `raw` (via logLlmCall) so the extraction is auditable.
 */
export async function runTool<T>(params: {
  model: string;
  system: string;
  content: Anthropic.MessageParam["content"];
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  maxTokens?: number;
}): Promise<ToolCallResult<T>> {
  const anthropic = getAnthropic();
  const message = await anthropic.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 8192,
    temperature: 0,
    system: params.system,
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        input_schema: { type: "object" as const, ...params.inputSchema },
      },
    ],
    tool_choice: { type: "tool", name: params.toolName },
    messages: [{ role: "user", content: params.content }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) throw new Error(`No tool_use block from ${params.model}`);
  const data = params.schema.parse(block.input);
  const usage = {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cost_usd: costUsd(params.model, message.usage.input_tokens, message.usage.output_tokens),
  };
  console.log(JSON.stringify({ msg: "llm-call", tool: params.toolName, model: params.model, ...usage }));
  return { data, raw: message, usage };
}

/** Persist the raw output + cost of a call to llm_calls (service role). */
export async function logLlmCall(
  svc: ServiceClient,
  entry: {
    tenant_id: string;
    kind: "recipe-draft" | "invoice-parse" | "sku-match" | "sheet-map";
    ref_id?: string | null;
    model: string;
    usage?: ToolCallResult<unknown>["usage"];
    raw?: unknown;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await svc.from("llm_calls").insert({
    tenant_id: entry.tenant_id,
    kind: entry.kind,
    ref_id: entry.ref_id ?? null,
    model: entry.model,
    input_tokens: entry.usage?.input_tokens ?? 0,
    output_tokens: entry.usage?.output_tokens ?? 0,
    cost_usd: entry.usage?.cost_usd ?? null,
    raw: (entry.raw ?? null) as Json,
    error: entry.error ?? null,
  });
  if (error) console.warn("llm_calls insert failed", error.message);
}
