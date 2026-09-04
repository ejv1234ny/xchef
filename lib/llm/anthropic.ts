import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import type { ServiceClient } from "@/lib/db/service";
import type { Json } from "@/lib/db/types";
import { costUsd, modelFor, MODELS, type LlmProviderName } from "./models";
import type { LlmFile, LlmProvider, LlmUsage, StructuredInput, StructuredResult } from "./provider";

export { MODELS, costUsd };

/**
 * Claude provider: one forced tool-use call, temperature 0, output validated
 * with zod. Kept as the alternative to OpenAI (LLM_PROVIDER=anthropic).
 * Identity-linked keys need ANTHROPIC_WORKSPACE_ID (sent as a header).
 */
let client: Anthropic | undefined;
export function getAnthropic(): Anthropic {
  if (!client) {
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

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function fileBlocks(files: LlmFile[] | undefined): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const f of files ?? []) {
    const mime = f.mimeType.toLowerCase().split(";")[0].trim();
    if (mime === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(f.bytes) } });
    else if (IMAGE_MIMES.has(mime)) blocks.push({ type: "image", source: { type: "base64", media_type: mime as ImageMime, data: toBase64(f.bytes) } });
    else blocks.push({ type: "text", text: `File ${f.name} (${mime}):\n${Buffer.from(f.bytes).toString("utf8")}` });
  }
  return blocks;
}

export function createAnthropicProvider(opts: { apiKey?: string; fetch?: typeof fetch } = {}): LlmProvider {
  let own: Anthropic | undefined;
  const getClient = () => {
    if (opts.apiKey || opts.fetch) {
      if (!own) own = new Anthropic({ apiKey: opts.apiKey ?? env.anthropicApiKey(), fetch: opts.fetch });
      return own;
    }
    return getAnthropic();
  };
  return {
    name: "anthropic",
    async structured<T>(input: StructuredInput<T>): Promise<StructuredResult<T>> {
      const model = input.model ?? modelFor("anthropic", input.task);
      const inputSchema = input.toolSchema ?? (z.toJSONSchema(input.schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>);
      const { type: _t, $schema: _s, ...rest } = inputSchema as { type?: unknown; $schema?: unknown } & Record<string, unknown>;
      void _t;
      void _s;
      const message = await getClient().messages.create({
        model,
        max_tokens: input.maxTokens ?? 8192,
        temperature: 0,
        system: input.system,
        tools: [{ name: input.schemaName, description: input.toolDescription ?? `Return ${input.schemaName}.`, input_schema: { type: "object" as const, ...rest } }],
        tool_choice: { type: "tool", name: input.schemaName },
        messages: [{ role: "user", content: [...fileBlocks(input.files), { type: "text", text: input.user }] }],
      });
      const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!block) throw new Error(`No tool_use block from ${model}`);
      const json = input.schema.parse(block.input);
      const usage: LlmUsage = {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cost_usd: costUsd(model, message.usage.input_tokens, message.usage.output_tokens),
      };
      console.log(JSON.stringify({ msg: "llm-call", provider: "anthropic", task: input.task, model, ...usage }));
      return { json, raw: message, usage, model, provider: "anthropic" };
    },
  };
}

/** Persist the raw output + cost of a call to llm_calls (service role). */
export async function logLlmCall(
  svc: ServiceClient,
  entry: {
    tenant_id: string;
    kind: "recipe-draft" | "invoice-parse" | "sku-match" | "sheet-map";
    ref_id?: string | null;
    model: string;
    provider?: LlmProviderName;
    usage?: LlmUsage;
    raw?: unknown;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await svc.from("llm_calls").insert({
    tenant_id: entry.tenant_id,
    kind: entry.kind,
    ref_id: entry.ref_id ?? null,
    model: entry.model,
    provider: entry.provider ?? (entry.model.startsWith("gpt") ? "openai" : "anthropic"),
    input_tokens: entry.usage?.input_tokens ?? 0,
    output_tokens: entry.usage?.output_tokens ?? 0,
    cost_usd: entry.usage?.cost_usd ?? null,
    raw: (entry.raw ?? null) as Json,
    error: entry.error ?? null,
  });
  if (error) console.warn("llm_calls insert failed", error.message);
}
