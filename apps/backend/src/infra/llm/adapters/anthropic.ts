import type { CompletionOpts, CompletionResult } from "../types";

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";

function getAnthropicApiKey(): string | null {
  const k = process.env.ANTHROPIC_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export function hasAnthropicApiKey(): boolean {
  return Boolean(getAnthropicApiKey());
}

export async function createAnthropicCompletion(
  opts: CompletionOpts,
  auth?: { apiKey?: string; baseURL?: string; version?: string }
): Promise<CompletionResult> {
  const apiKey = auth?.apiKey ?? getAnthropicApiKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in the environment.");

  const baseURL = (auth?.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

  const res = await fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": auth?.version ?? process.env.ANTHROPIC_VERSION ?? "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 5000,
      temperature: opts.temperature ?? 0.3,
      system: opts.system,
      messages: [{ role: "user", content: [{ type: "text", text: opts.user }] }],
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${raw.slice(0, 800)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Anthropic API returned non-JSON: ${raw.slice(0, 800)}`);
  }

  const text =
    Array.isArray(parsed?.content)
      ? parsed.content
          .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("")
      : "";

  const inputTokens = typeof parsed?.usage?.input_tokens === "number" ? parsed.usage.input_tokens : undefined;
  const outputTokens = typeof parsed?.usage?.output_tokens === "number" ? parsed.usage.output_tokens : undefined;
  const usage = {
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof inputTokens === "number" && typeof outputTokens === "number"
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
  };

  return {
    content: [{ type: "text", text }],
    meta: {
      provider: "anthropic",
      model: typeof parsed?.model === "string" ? parsed.model : model,
      ...(opts.role ? { role: opts.role } : {}),
      ...(typeof parsed?.stop_reason === "string" ? { finishReason: parsed.stop_reason } : {}),
      ...(parsed?.stop_reason === "max_tokens" ? { truncated: true } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    },
  };
}
