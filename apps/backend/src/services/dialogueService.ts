import { z } from "zod";
import type { ActivitySpec } from "../contracts/activitySpec";
import type { SpecDraft } from "../compiler/specDraft";
import { ActivityLanguageSchema } from "../contracts/activitySpec";
import { createCodemmCompletion } from "../infra/llm";
import { tryParseJson } from "../utils/jsonParser";
import { computeConfirmRequired } from "../agent/fieldCommitmentPolicy";

export type DialogueTurnInput = {
  sessionState: string;
  currentSpec: SpecDraft;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  latestUserMessage: string;
};

export type DialogueTurnOutput = {
  proposedPatch: Partial<ActivitySpec>;
  confidence: Partial<Record<keyof ActivitySpec, number>>;
  needsConfirmation?: string[];
  parseSource: "deterministic" | "llm";
};

const ProposedPatchSchema = z
  .object({
    language: ActivityLanguageSchema.optional(),
    problem_count: z.number().int().min(1).max(7).optional(),
    difficulty_plan: z
      .array(z.object({ difficulty: z.enum(["easy", "medium", "hard"]), count: z.number().int().min(0).max(7) }))
      .min(1)
      .max(3)
      .optional(),
    topic_tags: z.array(z.string().trim().min(1).max(40)).min(1).max(12).optional(),
    // Backwards-compatible: older model behaviors may still emit this field; engine ignores it (stdout-only).
    problem_style: z.enum(["stdout", "return", "mixed"]).optional(),
  })
  .strict();

const DialogueLlmSchema = z
  .object({
    acknowledgement: z.string().trim().min(1).max(600),
    inferred_intent: z.string().trim().min(1).max(800),
    proposedPatch: ProposedPatchSchema,
  })
  .strict();

function truncate(text: string, maxLen: number): string {
  const s = String(text ?? "");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…(truncated)`;
}

function extractLikelyJsonObject(raw: string): string | null {
  const text = String(raw ?? "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return null;
  return text.slice(first, last + 1);
}

function safeExtractPatchFromText(userMessage: string): Partial<ActivitySpec> {
  const msg = userMessage.trim();
  const lower = msg.toLowerCase();
  const patch: Partial<ActivitySpec> = {};

  // language
  if (/\bsql\b/.test(lower) || /\bsqlite\b/.test(lower)) patch.language = "sql";
  else if (/(^|[^a-z0-9])c\+\+([^a-z0-9]|$)/.test(lower) || /\bcpp\b/.test(lower)) patch.language = "cpp";
  else if (/\bpython\b/.test(lower)) patch.language = "python";
  else if (/\bjava\b/.test(lower)) patch.language = "java";

  // problem_count
  const countMatch =
    msg.match(/(\b\d+\b)\s*(?:problems?|questions?|exercises?)\b/i) ?? msg.match(/^(?:i want\s+)?(\d+)\b/i);
  if (countMatch?.[1]) {
    const n = Number(countMatch[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 7) patch.problem_count = n;
  }

  // topics (best-effort): "focus on X, Y" or comma-separated short list
  const topicTail = msg.replace(/^.*\b(?:topics?|focus on|about|cover)\b/i, "").trim();
  const candidate = topicTail && topicTail.length <= 200 ? topicTail : msg.length <= 120 && msg.includes(",") ? msg : "";
  if (candidate) {
    const tags = candidate
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length <= 40)
      .slice(0, 12);
    if (tags.length) patch.topic_tags = tags;
  }

  return patch;
}

function stripUndefinedValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function hasMeaningfulPatch(patch: Partial<ActivitySpec>): boolean {
  return Object.keys(patch).length > 0;
}

export async function runDialogueTurn(input: DialogueTurnInput): Promise<DialogueTurnOutput> {
  let parsed: z.infer<typeof DialogueLlmSchema> | null = null;
  const deterministicPatch = safeExtractPatchFromText(input.latestUserMessage);
  const usedDeterministic = hasMeaningfulPatch(deterministicPatch);

  if (!usedDeterministic) {
    const history = input.conversationHistory
      .slice(-10)
      .map((m) => ({ role: m.role, content: truncate(m.content, 700) }));

    const system = `
You are Codemm's dialogue parser.

Your job:
- Read the conversation + latest user message.
- Propose a PARTIAL spec patch (may be empty). Never require all fields in one turn.

Hard rules:
- Output ONLY valid JSON (no markdown, no prose outside JSON).
- Do NOT include chain-of-thought or hidden reasoning.
- Do NOT ask ANY questions. The server will deterministically choose the next question.
- Only propose these patch fields (omit anything else):
  - language: one of ${ActivityLanguageSchema.options.join(", ")}
  - problem_count: 1..7
  - difficulty_plan: [{difficulty: easy|medium|hard, count: 0..7}] (max 3 items)
  - topic_tags: string[] (1..12 items, 1..40 chars each)
`.trim();

    const user = `
Session state: ${input.sessionState}
Current partial spec: ${truncate(JSON.stringify(input.currentSpec), 2000)}

Conversation history (most recent last):
${history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")}

Latest user message:
${truncate(input.latestUserMessage, 1200)}

Return JSON with this exact shape:
{
  "acknowledgement": "string",
  "inferred_intent": "string",
  "proposedPatch": { ...partial fields... }
}
`.trim();

    try {
      const completion = await createCodemmCompletion({
        system,
        user,
        role: "dialogue",
        temperature: 0,
        maxTokens: 900,
      });
      const raw = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");

      const attempt1 = tryParseJson(raw);
      const res1 = DialogueLlmSchema.safeParse(attempt1);
      if (res1.success) parsed = res1.data;
      else {
        // Deterministic repair pass: extract a likely JSON object substring and retry.
        const extracted = extractLikelyJsonObject(raw);
        if (extracted) {
          const attempt2 = tryParseJson(extracted);
          const res2 = DialogueLlmSchema.safeParse(attempt2);
          if (res2.success) parsed = res2.data;
        }
      }
    } catch {
      // fall through to deterministic fallback
    }
  }

  const rawPatch = (parsed?.proposedPatch ?? deterministicPatch) as unknown as Record<
    string,
    unknown
  >;
  const proposedPatch = stripUndefinedValues(rawPatch) as Partial<ActivitySpec>;
  // Product decision: stdout-only. Treat problem_style as non-user-editable and ignore any proposal.
  delete (proposedPatch as any).problem_style;

  const confirm = computeConfirmRequired({
    userMessage: input.latestUserMessage,
    currentSpec: input.currentSpec,
    inferredPatch: proposedPatch as any,
  });
  const needsConfirmation = confirm.required ? confirm.fields.map(String) : undefined;
  const confidence: Partial<Record<keyof ActivitySpec, number>> = {};
  for (const key of Object.keys(proposedPatch) as Array<keyof ActivitySpec>) {
    confidence[key] = usedDeterministic ? 1 : 0.7;
  }

  return {
    proposedPatch,
    confidence,
    ...(needsConfirmation?.length ? { needsConfirmation } : {}),
    parseSource: usedDeterministic ? "deterministic" : "llm",
  };
}
