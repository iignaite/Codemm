import type { CompletionOpts, CompletionResult } from "../types";

export function hasOllamaModelConfigured(): boolean {
  const m = process.env.CODEMM_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL;
  return typeof m === "string" && Boolean(m.trim());
}

function getOllamaModelOrThrow(explicit?: string): string {
  const m = explicit ?? process.env.CODEMM_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL ?? "";
  const model = typeof m === "string" ? m.trim() : "";
  if (!model) {
    throw new Error(
      'Ollama is selected but no model is configured. Set CODEMM_OLLAMA_MODEL (example: "qwen2.5-coder:7b") and ensure Ollama is running.'
    );
  }
  return model;
}

function getOllamaBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env.CODEMM_OLLAMA_URL ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  return raw.replace(/\/+$/, "");
}

async function fetchJson(url: string, opts: { method: string; body: unknown; timeoutMs: number }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama request failed (${res.status}): ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text) as any;
    } catch {
      throw new Error(`Ollama returned non-JSON: ${text.slice(0, 400)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

export async function createOllamaCompletion(
  opts: CompletionOpts,
  auth?: { baseURL?: string; model?: string }
): Promise<CompletionResult> {
  const baseUrl = getOllamaBaseUrl(auth?.baseURL);
  const model = getOllamaModelOrThrow(opts.model ?? auth?.model);

  const temperature = typeof opts.temperature === "number" && Number.isFinite(opts.temperature) ? opts.temperature : undefined;
  const maxTokens = typeof opts.maxTokens === "number" && Number.isFinite(opts.maxTokens) ? Math.max(64, Math.floor(opts.maxTokens)) : undefined;

  const body = {
    model,
    stream: false,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    ...(typeof temperature === "number" ? { options: { temperature, ...(typeof maxTokens === "number" ? { num_predict: maxTokens } : {}) } } : typeof maxTokens === "number" ? { options: { num_predict: maxTokens } } : {}),
  };

  const json = await fetchJson(`${baseUrl}/api/chat`, { method: "POST", body, timeoutMs: 120_000 });
  const text =
    (json && json.message && typeof json.message.content === "string" ? json.message.content : null) ??
    (json && typeof json.response === "string" ? json.response : null) ??
    "";

  if (!text.trim()) {
    throw new Error("Ollama returned an empty completion.");
  }

  const promptEvalCount = typeof json?.prompt_eval_count === "number" ? json.prompt_eval_count : undefined;
  const evalCount = typeof json?.eval_count === "number" ? json.eval_count : undefined;
  const usage = {
    ...(typeof promptEvalCount === "number" ? { inputTokens: promptEvalCount } : {}),
    ...(typeof evalCount === "number" ? { outputTokens: evalCount } : {}),
    ...(typeof promptEvalCount === "number" && typeof evalCount === "number"
      ? { totalTokens: promptEvalCount + evalCount }
      : {}),
  };

  return {
    content: [{ type: "text", text }],
    meta: {
      provider: "ollama",
      model,
      ...(typeof json?.done_reason === "string" ? { finishReason: json.done_reason } : {}),
      ...(json?.done_reason === "length" ? { truncated: true } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    },
  };
}
