import type { CompletionOpts, CompletionResult } from "../types";

// Default to a broadly available model (free keys often lack access to Pro).
// Default to a broadly available model (Pro is preferred for reasoning, Flash for backup).
const DEFAULT_GEMINI_MODEL = "gemini-1.5-pro";

function getGeminiApiKey(): string | null {
  const k = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

type GeminiModelInfo = {
  name?: string;
  supportedGenerationMethods?: string[];
};

function normalizeGeminiModelName(name: string): string {
  const s = String(name ?? "").trim();
  return s.startsWith("models/") ? s.slice("models/".length) : s;
}

function looksLikeModelNotFound(status: number, raw: string): boolean {
  if (status === 404) return true;
  if (status === 400 && /not found/i.test(raw)) return true;
  const msg = String(raw ?? "");
  return /models\/.+ is not found|not supported for generateContent|call listmodels/i.test(msg);
}

function pickSupportedModelFromList(models: GeminiModelInfo[], preferred: string[]): string | null {
  const supported = models
    .map((m) => ({
      name: typeof m?.name === "string" ? normalizeGeminiModelName(m.name) : "",
      methods: Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
    }))
    .filter((m) => Boolean(m.name) && m.methods.includes("generateContent"))
    .map((m) => m.name);

  if (supported.length === 0) return null;

  const preferredNormalized = preferred.map(normalizeGeminiModelName);
  for (const want of preferredNormalized) {
    if (supported.includes(want)) return want;
  }

  // Heuristic: Prefer "pro" models for quality, then "flash" for speed/availability.
  const pro = supported.filter((m) => /\bpro\b/i.test(m));
  if (pro.length) return pro.sort((a, b) => a.localeCompare(b))[0]!;

  const flash = supported.filter((m) => /\bflash\b/i.test(m));
  if (flash.length) return flash.sort((a, b) => a.localeCompare(b))[0]!;

  return supported.sort((a, b) => a.localeCompare(b))[0]!;
}

export async function createGeminiCompletion(
  opts: CompletionOpts,
  auth?: { apiKey?: string; baseURL?: string }
): Promise<CompletionResult> {
  const apiKey = auth?.apiKey ?? getGeminiApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set in the environment.");
  const apiKeyStr = apiKey;

  const baseURL = (auth?.baseURL ?? process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    ""
  );
  const preferredModel = opts.model ?? process.env.GEMINI_MODEL ?? process.env.CODEX_MODEL ?? DEFAULT_GEMINI_MODEL;

  // Conservative: combine system + user to avoid API/version quirks around system instruction fields.
  const prompt = `${opts.system}\n\n${opts.user}`.trim();

  async function requestOnce(model: string): Promise<{ status: number; raw: string }> {
    const url = `${baseURL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKeyStr)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 5000,
        },
      }),
    });
    return { status: res.status, raw: await res.text() };
  }

  async function listModels(): Promise<GeminiModelInfo[]> {
    const url = `${baseURL}/models?key=${encodeURIComponent(apiKeyStr)}`;
    const res = await fetch(url, { method: "GET" });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Gemini ListModels error (${res.status}): ${raw.slice(0, 800)}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini ListModels returned non-JSON: ${raw.slice(0, 800)}`);
    }
    return Array.isArray(parsed?.models) ? (parsed.models as GeminiModelInfo[]) : [];
  }

  // Fallback Logic:
  // 1. Try preferred model (default: gemini-1.5-pro)
  // 2. If 404/NotFound (e.g. free tier limit or invalid name) -> Try "gemini-1.5-flash" explicitly
  // 3. If still fails -> ListModels and pick best available

  let finalRaw: string;
  let finalStatus: number;
  const tried = new Set<string>();

  const firstModel = normalizeGeminiModelName(preferredModel);
  tried.add(firstModel);
  const first = await requestOnce(firstModel);
  finalRaw = first.raw;
  finalStatus = first.status;

  // Explicit Fallback: particular for free tier users where 'pro' might be unavailable or 404s
  if (looksLikeModelNotFound(finalStatus, finalRaw)) {
    // console.warn(`Gemini model ${firstModel} failed (${finalStatus}), trying fallback logic...`);
    const fallbackFlash = normalizeGeminiModelName("gemini-1.5-flash");
    if (!tried.has(fallbackFlash)) {
      tried.add(fallbackFlash);
      const retry = await requestOnce(fallbackFlash);
      finalRaw = retry.raw;
      finalStatus = retry.status;
    }
  }

  if (looksLikeModelNotFound(finalStatus, finalRaw)) {
    const models = await listModels();
    const picked = pickSupportedModelFromList(models, [
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ]);
    if (picked && !tried.has(picked)) {
      tried.add(picked);
      const retry = await requestOnce(picked);
      finalRaw = retry.raw;
      finalStatus = retry.status;
    }
  }

  if (finalStatus < 200 || finalStatus >= 300) {
    // Enhance error with the list of models we tried
    const triedList = Array.from(tried).join(", ");
    throw new Error(`Gemini API error (${finalStatus}) after trying [${triedList}]: ${finalRaw.slice(0, 800)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(finalRaw);
  } catch {
    throw new Error(`Gemini API returned non-JSON: ${finalRaw.slice(0, 800)}`);
  }

  const parts = parsed?.candidates?.[0]?.content?.parts;
  const text =
    Array.isArray(parts)
      ? parts
        .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim()
      : "";

  const finishReason =
    typeof parsed?.candidates?.[0]?.finishReason === "string" ? parsed.candidates[0].finishReason : undefined;
  const promptTokenCount =
    typeof parsed?.usageMetadata?.promptTokenCount === "number" ? parsed.usageMetadata.promptTokenCount : undefined;
  const candidatesTokenCount =
    typeof parsed?.usageMetadata?.candidatesTokenCount === "number"
      ? parsed.usageMetadata.candidatesTokenCount
      : undefined;
  const totalTokenCount =
    typeof parsed?.usageMetadata?.totalTokenCount === "number" ? parsed.usageMetadata.totalTokenCount : undefined;
  const usage = {
    ...(typeof promptTokenCount === "number" ? { inputTokens: promptTokenCount } : {}),
    ...(typeof candidatesTokenCount === "number" ? { outputTokens: candidatesTokenCount } : {}),
    ...(typeof totalTokenCount === "number" ? { totalTokens: totalTokenCount } : {}),
  };

  return {
    content: [{ type: "text", text }],
    meta: {
      provider: "gemini",
      model:
        typeof parsed?.modelVersion === "string"
          ? parsed.modelVersion
          : Array.from(tried).slice(-1)[0] ?? firstModel,
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(finishReason === "MAX_TOKENS" ? { truncated: true } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    },
  };
}
