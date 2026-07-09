"use client";

import { useCallback, useMemo, useState } from "react";
import { normalizeUserInput } from "./specNormalization";

export type BackendSpecResponse = {
  accepted: boolean;
  error?: string;
  nextQuestion?: string;
  questionKey?: string | null;
  done: boolean;
  state?: string;
};

export type SpecSlot = {
  key: "language" | "problem_count" | "difficulty_plan" | "topic_tags" | "constraints";
  intent: string;
  examples?: string[];
};

export type NormalizedInputResult =
  | { ok: true; value: string; slot: SpecSlot }
  | { ok: false; slot: SpecSlot; friendly: string; hintLines: string[] };

export type SpecInteractionResult =
  | { kind: "accepted"; done: boolean; nextSlot: SpecSlot | null }
  | { kind: "rejected"; slot: SpecSlot | null; friendly: string; hintLines: string[] };

function deriveSlotKeyFromQuestion(question?: string | null): SpecSlot["key"] | null {
  const lower = (question ?? "").toLowerCase();
  const tail = lower.split("\n\n").pop() ?? lower;
  if (!lower.trim()) return null;
  if (tail.includes("language") || tail.includes("java is available")) return "language";
  if (tail.includes("how many problems") || tail.includes("how many")) return "problem_count";
  if (tail.includes("how hard") || tail.includes("easy") || tail.includes("medium") || tail.includes("hard"))
    return "difficulty_plan";
  if (tail.includes("topics") || tail.includes("tags")) return "topic_tags";
  if (tail.includes("constraints") || tail.includes("java/junit setup")) return "constraints";
  return null;
}

function deriveSlotKeyFromQuestionKey(key?: string | null): SpecSlot["key"] | null {
  const k = (key ?? "").trim().toLowerCase();
  if (!k) return null;
  if (k === "ready") return null;
  if (k.startsWith("invalid:")) return (k.slice("invalid:".length) as SpecSlot["key"]) ?? null;
  if (k.startsWith("confirm:")) {
    const first = k
      .slice("confirm:".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return (first as SpecSlot["key"] | undefined) ?? null;
  }
  if (k.startsWith("goal:")) {
    const goal = k.slice("goal:".length);
    if (goal === "content") return "topic_tags";
    if (goal === "scope") return "problem_count";
    if (goal === "difficulty") return "difficulty_plan";
    if (goal === "language") return "language";
  }
  return null;
}

function humanizeSpecError(err: string, slot?: SpecSlot | null): { friendly: string; hints: string[] } {
  const lower = err.toLowerCase();

  if (slot?.key === "difficulty_plan" || lower.includes("sum")) {
    return {
      friendly: "I almost got that 🙂 Try sharing the difficulty spread like easy:2, medium:2, hard:1.",
      hints: ["Make sure the counts add up to your total problems.", "Use comma-separated key:value pairs."],
    };
  }

  if (slot?.key === "constraints" || lower.includes("junit") || lower.includes("package")) {
    return {
      friendly: "I'll handle the language runtime and test setup automatically.",
      hints: ["You can just say 'ok' or 'go ahead' here."],
    };
  }

  if (slot?.key === "topic_tags") {
    return {
      friendly: "List the topics as a short comma-separated list.",
      hints: ["Example: encapsulation, inheritance, polymorphism"],
    };
  }

  if (slot?.key === "problem_count") {
    return {
      friendly: "Share how many problems you want (1-7).",
      hints: ["Just a number like 3 or 5 is perfect."],
    };
  }

  if (slot?.key === "language") {
    return {
      friendly: "Pick a supported language.",
      hints: ["Reply with 'java', 'python', 'cpp', or 'sql'."],
    };
  }

  return {
    friendly: "I got the intent—let's tweak the format slightly.",
    hints: ["Try concise, structured text like key:value pairs if you're specifying counts."],
  };
}

const SPEC_SLOTS: SpecSlot[] = [
  {
    key: "topic_tags",
    intent: "What should the problems focus on?",
    examples: ["arrays, recursion, hash maps"],
  },
  {
    key: "problem_count",
    intent: "How many problems should we build? (1-7 is okay.)",
    examples: ["3", "5 problems"],
  },
  {
    key: "difficulty_plan",
    intent: "How hard should these problems be overall?",
    examples: ["easy:2, medium:2, hard:1", "2 easy, 2 medium, 1 hard"],
  },
  {
    key: "language",
    intent: "Which language should we use?",
    examples: ["java", "python", "cpp", "sql"],
  },
  {
    key: "constraints",
    intent: "I’ll handle the runtime + test setup. Any constraints you want noted?",
    examples: ["ok", "that's fine", "any"],
  },
];

export function useSpecBuilderUX() {
  const [activeSlotKey, setActiveSlotKey] = useState<SpecSlot["key"] | null>("topic_tags");

  const activeSlot = useMemo(
    () => SPEC_SLOTS.find((s) => s.key === activeSlotKey) ?? SPEC_SLOTS[0],
    [activeSlotKey]
  );

  const formatSlotPrompt = useCallback((slot: SpecSlot | null): string | null => {
    if (!slot) return null;
    if (slot.examples?.length) return `${slot.intent} Example: ${slot.examples[0]}`;
    return slot.intent;
  }, []);

  const normalizeInput = useCallback(
    (input: string): NormalizedInputResult => {
      const slot = activeSlot;
      const { normalized } = normalizeUserInput(input);
      if (!normalized.trim()) {
        return {
          ok: false,
          slot,
          friendly: "Type an answer to continue.",
          hintLines: [],
        };
      }
      return { ok: true, value: normalized, slot };
    },
    [activeSlot]
  );

  const interpretResponse = useCallback(
    (payload: BackendSpecResponse): SpecInteractionResult => {
      const derivedKey =
        deriveSlotKeyFromQuestionKey(payload.questionKey) ??
        deriveSlotKeyFromQuestion(payload.nextQuestion) ??
        activeSlotKey;
      const derivedSlot = derivedKey
        ? SPEC_SLOTS.find((s) => s.key === derivedKey) ?? activeSlot
        : activeSlot;

      if (payload.accepted) {
        const nextSlot = payload.done ? null : derivedSlot;
        setActiveSlotKey(nextSlot?.key ?? null);
        return {
          kind: "accepted",
          done: payload.done ?? false,
          nextSlot,
        };
      }

      setActiveSlotKey(derivedSlot.key);
      const { friendly, hints } = humanizeSpecError(payload.error ?? "", derivedSlot);
      return {
        kind: "rejected",
        slot: derivedSlot,
        friendly,
        hintLines: hints,
      };
    },
    [activeSlot, activeSlotKey]
  );

  return {
    activeSlot,
    formatSlotPrompt,
    normalizeInput,
    interpretResponse,
  };
}
