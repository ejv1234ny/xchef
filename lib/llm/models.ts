/**
 * Pinned model ids and list prices, in one place. Change here only, with a
 * note in the commit message. Prices are USD per million tokens and feed the
 * llm_calls cost log (not billing).
 */
export type LlmTask = "invoice-parse" | "recipe-draft" | "sku-match" | "sheet-map";
export type LlmProviderName = "openai" | "anthropic";

export const OPENAI_MODELS: Record<LlmTask, string> = {
  "invoice-parse": "gpt-4.1",
  "recipe-draft": "gpt-4.1",
  "sku-match": "gpt-4.1-mini",
  "sheet-map": "gpt-4.1-mini",
};

export const ANTHROPIC_MODELS: Record<LlmTask, string> = {
  "invoice-parse": "claude-sonnet-5",
  "recipe-draft": "claude-sonnet-5",
  "sku-match": "claude-haiku-4-5-20251001",
  "sheet-map": "claude-haiku-4-5-20251001",
};

/** Kept for existing call sites that reference Claude models by family. */
export const MODELS = { sonnet: ANTHROPIC_MODELS["invoice-parse"], haiku: ANTHROPIC_MODELS["sku-match"] } as const;

export const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function costUsd(model: string, input: number, output: number): number {
  const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0 };
  return (input * p.input + output * p.output) / 1_000_000;
}

export function modelFor(provider: LlmProviderName, task: LlmTask): string {
  return provider === "openai" ? OPENAI_MODELS[task] : ANTHROPIC_MODELS[task];
}
