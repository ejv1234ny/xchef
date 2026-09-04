import OpenAI from "openai";
import { env } from "@/lib/env";
import { costUsd, modelFor } from "./models";
import type { LlmFile, LlmProvider, StructuredInput, StructuredResult } from "./provider";
import { stripOptionalNulls, toStrictJsonSchema } from "./strict-schema";

/**
 * OpenAI Responses API with strict JSON-schema structured output
 * (`text.format = { type: "json_schema", strict: true }`), temperature 0.
 * Images → input_image (base64 data URL), PDFs → input_file (base64),
 * everything else (CSV/TSV/plain text) is already in the prompt text.
 */
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function dataUrl(f: LlmFile): string {
  return `data:${f.mimeType};base64,${Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).toString("base64")}`;
}

export function fileParts(files: LlmFile[] | undefined): OpenAI.Responses.ResponseInputContent[] {
  const parts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const f of files ?? []) {
    const mime = f.mimeType.toLowerCase().split(";")[0].trim();
    if (IMAGE_MIMES.has(mime)) parts.push({ type: "input_image", image_url: dataUrl(f), detail: "high" });
    else if (mime === "application/pdf") parts.push({ type: "input_file", filename: f.name || "document.pdf", file_data: dataUrl(f) });
    else parts.push({ type: "input_text", text: `File ${f.name} (${mime}):\n${Buffer.from(f.bytes).toString("utf8")}` });
  }
  return parts;
}

export function createOpenAIProvider(opts: { apiKey?: string; fetch?: typeof fetch } = {}): LlmProvider {
  let client: OpenAI | undefined;
  const getClient = () => {
    if (!client) client = new OpenAI({ apiKey: opts.apiKey ?? env.openaiApiKey(), fetch: opts.fetch, maxRetries: 2 });
    return client;
  };
  return {
    name: "openai",
    async structured<T>(input: StructuredInput<T>): Promise<StructuredResult<T>> {
      const model = input.model ?? modelFor("openai", input.task);
      const { schema, optionalPaths } = toStrictJsonSchema(input.schema);
      const response = await getClient().responses.create({
        model,
        temperature: 0,
        max_output_tokens: input.maxTokens ?? 8192,
        input: [
          { role: "system", content: input.system },
          { role: "user", content: [{ type: "input_text", text: input.user }, ...fileParts(input.files)] },
        ],
        text: { format: { type: "json_schema", name: input.schemaName, schema, strict: true } },
      });
      const refusal = response.output
        .flatMap((o) => (o.type === "message" ? o.content : []))
        .find((c) => c.type === "refusal");
      if (refusal && refusal.type === "refusal") throw new Error(`OpenAI refused: ${refusal.refusal}`);
      const text = response.output_text;
      if (!text) throw new Error(`OpenAI returned no output_text (status ${response.status ?? "?"}${response.incomplete_details ? `, ${response.incomplete_details.reason}` : ""})`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`OpenAI output is not JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      const json = input.schema.parse(stripOptionalNulls(parsed, optionalPaths));
      const inTok = response.usage?.input_tokens ?? 0;
      const outTok = response.usage?.output_tokens ?? 0;
      const usage = { input_tokens: inTok, output_tokens: outTok, cost_usd: costUsd(model, inTok, outTok) };
      console.log(JSON.stringify({ msg: "llm-call", provider: "openai", task: input.task, model, ...usage }));
      return { json, raw: response, usage, model, provider: "openai" };
    },
  };
}
