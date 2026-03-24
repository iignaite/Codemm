import OpenAI from "openai";
import type { CompletionOpts, CompletionResult } from "../types";

const DEFAULT_OPENAI_MODEL = "gpt-4.1";

let openaiClient: OpenAI | null = null;
let openaiClientKey: string | null = null;
let openaiClientBaseUrl: string | null = null;

function getOpenAiApiKey(): string | null {
  const k = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export function hasOpenAiApiKey(): boolean {
  return Boolean(getOpenAiApiKey());
}

export function getOpenAiClient(): OpenAI {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OpenAI client requested but no OpenAI API key is set (CODEX_API_KEY or OPENAI_API_KEY).");
  }
  const baseURL = process.env.CODEX_BASE_URL ?? null;
  if (!openaiClient || openaiClientKey !== apiKey || openaiClientBaseUrl !== baseURL) {
    openaiClient = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    openaiClientKey = apiKey;
    openaiClientBaseUrl = baseURL;
  }
  return openaiClient;
}

function getOpenAiClientForRequest(auth?: { apiKey?: string; baseURL?: string }): OpenAI {
  if (auth?.apiKey) {
    const baseURL = auth.baseURL ?? process.env.CODEX_BASE_URL;
    return new OpenAI({ apiKey: auth.apiKey, ...(baseURL ? { baseURL } : {}) });
  }
  return getOpenAiClient();
}

export async function createOpenAiCompletion(
  opts: CompletionOpts,
  auth?: { apiKey?: string; baseURL?: string }
): Promise<CompletionResult> {
  const client = getOpenAiClientForRequest(auth);
  const completion = await client.chat.completions.create({
    model: opts.model ?? process.env.CODEX_MODEL ?? DEFAULT_OPENAI_MODEL,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 5000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";
  const finishReason = completion.choices[0]?.finish_reason ?? undefined;
  const promptTokens =
    typeof completion.usage?.prompt_tokens === "number" ? completion.usage.prompt_tokens : undefined;
  const completionTokens =
    typeof completion.usage?.completion_tokens === "number" ? completion.usage.completion_tokens : undefined;
  const totalTokens = typeof completion.usage?.total_tokens === "number" ? completion.usage.total_tokens : undefined;
  const usage = {
    ...(typeof promptTokens === "number" ? { inputTokens: promptTokens } : {}),
    ...(typeof completionTokens === "number" ? { outputTokens: completionTokens } : {}),
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
  };

  return {
    content: [{ type: "text", text }],
    meta: {
      provider: "openai",
      model: completion.model ?? (opts.model ?? process.env.CODEX_MODEL ?? DEFAULT_OPENAI_MODEL),
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(finishReason === "length" ? { truncated: true } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    },
  };
}
