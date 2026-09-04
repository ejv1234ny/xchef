import type { z } from "zod";
import { env } from "@/lib/env";
import type { LlmProviderName, LlmTask } from "./models";
import { createOpenAIProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";

/**
 * Provider-neutral structured-output call. Every LLM feature (invoice parse,
 * recipe draft, SKU match, sheet map) goes through `structured()`; the
 * provider (OpenAI by default, Claude as the alternative) is chosen once from
 * LLM_PROVIDER. Errors are thrown as plain Errors so callers keep logging them
 * to llm_calls / invoice_documents.parse_error exactly as before.
 */
export type LlmFile = { bytes: Uint8Array; mimeType: string; name: string };

export type StructuredInput<T> = {
  task: LlmTask;
  system: string;
  user: string;
  files?: LlmFile[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** hand-written JSON schema with descriptions (Anthropic tool input); OpenAI derives a strict schema from zod */
  toolSchema?: Record<string, unknown>;
  toolDescription?: string;
  maxTokens?: number;
  /** override the task's pinned model (tests) */
  model?: string;
};

export type LlmUsage = { input_tokens: number; output_tokens: number; cost_usd: number };

export type StructuredResult<T> = {
  json: T;
  raw: unknown;
  usage: LlmUsage;
  model: string;
  provider: LlmProviderName;
};

export interface LlmProvider {
  readonly name: LlmProviderName;
  structured<T>(input: StructuredInput<T>): Promise<StructuredResult<T>>;
}

/** Result shape the four lib/llm modules return to jobs (unchanged field names, plus model/provider). */
export type ToolCallResult<T> = { data: T; raw: unknown; usage: LlmUsage; model: string; provider: LlmProviderName };

export function toToolCallResult<T>(r: StructuredResult<T>): ToolCallResult<T> {
  return { data: r.json, raw: r.raw, usage: r.usage, model: r.model, provider: r.provider };
}

export function selectedProviderName(): LlmProviderName {
  const v = (process.env.LLM_PROVIDER ?? "openai").trim().toLowerCase();
  return v === "anthropic" ? "anthropic" : "openai";
}

/** True when the selected provider has its API key. */
export function isLlmConfigured(): boolean {
  return selectedProviderName() === "openai" ? env.has("OPENAI_API_KEY") : env.has("ANTHROPIC_API_KEY");
}

let cached: { name: LlmProviderName; provider: LlmProvider } | undefined;
let override: LlmProvider | undefined;

/** The provider for LLM_PROVIDER (default openai). Lazy so builds and tests never need a key. */
export function getProvider(): LlmProvider {
  if (override) return override;
  const name = selectedProviderName();
  if (cached?.name === name) return cached.provider;
  const impl: LlmProvider = name === "openai" ? createOpenAIProvider() : createAnthropicProvider();
  cached = { name, provider: impl };
  return impl;
}

/** Tests: inject a provider (pass undefined to clear). */
export function setProviderForTests(p: LlmProvider | undefined): void {
  override = p;
}
