import type { Difficulty, GenerationLanguage, GenerationProgressEvent } from "@codemm/shared-contracts";

export type SlotStage = "queued" | "llm" | "contract" | "docker" | "done" | "failed";

export type SlotProgress = {
  stage: SlotStage;
  attempt: number;
  difficulty: Difficulty | null;
  topic: string | null;
  language: GenerationLanguage | null;
  stageDone: { llm: boolean; contract: boolean; docker: boolean };
  lastFailure: { stage: "contract" | "docker"; message: string } | null;
};

export type GenerationProgressState = {
  totalSlots: number;
  run: number;
  slots: SlotProgress[];
  error: string | null;
  lastHeartbeatTs: string | null;
};

function createQueuedSlots(total: number): SlotProgress[] {
  return Array.from({ length: total }, () => ({
    stage: "queued",
    attempt: 0,
    difficulty: null,
    topic: null,
    language: null,
    stageDone: { llm: false, contract: false, docker: false },
    lastFailure: null,
  }));
}

export function reduceGenerationProgress(args: {
  progress: GenerationProgressState | null;
  event: GenerationProgressEvent;
}): { progress: GenerationProgressState | null; hint?: string | null } {
  const typed = args.event;

  if (typed.type === "generation_started") {
    const total = Math.max(1, typed.totalSlots ?? typed.totalProblems ?? 1);
    return {
      progress: { totalSlots: total, run: typed.run ?? 1, slots: createQueuedSlots(total), error: null, lastHeartbeatTs: null },
    };
  }

  if (!args.progress) return { progress: args.progress };

  const next: GenerationProgressState = {
    ...args.progress,
    slots: args.progress.slots.map((p) => ({
      ...p,
      stageDone: { ...p.stageDone },
      lastFailure: p.lastFailure ? { ...p.lastFailure } : null,
    })),
  };

  if (typed.type === "heartbeat") {
    next.lastHeartbeatTs = typed.ts;
    return { progress: next };
  }

  if (typed.type === "generation_soft_fallback_applied") {
    return { progress: next, hint: `Fallback applied: ${typed.reason}` };
  }

  if (typed.type === "route_selected") {
    return {
      progress: next,
      ...(typed.model ? { hint: `Slot ${typed.slotIndex + 1}: using ${typed.routeRole} model ${typed.model}.` } : {}),
    };
  }

  const getSlot = (slotIndex: number) => next.slots[slotIndex];

  if (typed.type === "slot_stage_started") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.attempt = typed.attempt;
      p.stage = typed.stage === "validate" ? "docker" : "llm";
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "slot_stage_finished") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.attempt = typed.attempt;
      if (typed.status === "failed") {
        p.stage = typed.stage === "validate" ? "docker" : "contract";
        p.lastFailure = {
          stage: typed.stage === "validate" ? "docker" : "contract",
          message: typed.message || `${typed.stage} failed.`,
        };
      } else if (typed.stage === "validate") {
        p.stage = "docker";
        p.stageDone = { llm: true, contract: true, docker: true };
      } else {
        p.stage = "llm";
      }
    }
    return { progress: next };
  }

  if (typed.type === "slot_escalated") {
    const target = typed.toModel ? ` to ${typed.toModel}` : "";
    return { progress: next, hint: `Slot ${typed.slotIndex + 1}: escalating ${typed.stage}${target}.` };
  }

  if (typed.type === "slot_failed_terminal") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "failed";
      p.lastFailure = { stage: typed.stage === "validate" ? "docker" : "contract", message: typed.message };
    }
    return { progress: next, hint: `Slot ${typed.slotIndex + 1}: ${typed.terminationReason}.` };
  }

  if (typed.type === "slot_started") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.difficulty = typed.difficulty;
      p.topic = typed.topic;
      p.language = typed.language;
      if (p.stage === "queued") p.stage = "llm";
    }
    return { progress: next };
  }

  if (typed.type === "slot_llm_attempt_started") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "llm";
      p.attempt = typed.attempt;
      p.stageDone = { llm: false, contract: false, docker: false };
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "slot_contract_validated") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "docker";
      p.attempt = typed.attempt;
      p.stageDone.llm = true;
      p.stageDone.contract = true;
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "slot_contract_failed") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "contract";
      p.attempt = typed.attempt;
      p.lastFailure = { stage: "contract", message: typed.shortError };
    }
    return { progress: next };
  }

  if (typed.type === "slot_docker_validation_started") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "docker";
      p.attempt = typed.attempt;
      p.stageDone.llm = true;
      p.stageDone.contract = true;
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "slot_docker_validation_failed") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "docker";
      p.attempt = typed.attempt;
      p.lastFailure = { stage: "docker", message: typed.shortError };
    }
    return { progress: next };
  }

  if (typed.type === "slot_attempt_summary") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.attempt = typed.attempt;
      if (typed.status === "failed") {
        p.stage = typed.phase === "validate" ? "docker" : "contract";
        p.lastFailure = {
          stage: typed.phase === "validate" ? "docker" : "contract",
          message: typed.message || "Slot attempt failed.",
        };
      }
    }
    if (typed.llm?.truncated) {
      const modelLabel = typed.llm.model ? `${typed.llm.provider}/${typed.llm.model}` : typed.llm.provider;
      return { progress: next, hint: `Model output may be truncated (${modelLabel}).` };
    }
    return { progress: next };
  }

  if (typed.type === "slot_failure_diagnostic") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      const stage = typed.kind === "compile" || typed.kind === "tests" || typed.kind === "timeout" ? "docker" : "contract";
      p.stage = stage;
      p.attempt = typed.attempt;
      p.lastFailure = {
        stage,
        message: typed.message || "Slot failed.",
      };
    }
    if (typed.remediation.length > 0) {
      const prefix = typed.final ? "Final slot failure" : "Slot failure";
      return { progress: next, hint: `${prefix}: ${typed.remediation.slice(0, 2).join(" | ")}` };
    }
    return { progress: next };
  }

  if (typed.type === "slot_repair_applied") {
    return { progress: next, hint: `Repair applied on slot ${typed.slotIndex + 1}: ${typed.strategy.replaceAll("_", " ")}.` };
  }

  if (typed.type === "slot_completed") {
    const p = getSlot(typed.slotIndex);
    if (p) {
      p.stage = "done";
      p.stageDone = { llm: true, contract: true, docker: true };
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "problem_started") {
    const p = getSlot(typed.index);
    if (p) {
      p.difficulty = typed.difficulty;
      p.stage = "llm";
      p.attempt = 0;
      p.stageDone = { llm: false, contract: false, docker: false };
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "attempt_started") {
    const p = getSlot(typed.index);
    if (p) {
      p.stage = "llm";
      p.attempt = typed.attempt;
      p.stageDone = { llm: false, contract: false, docker: false };
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "validation_started") {
    const p = getSlot(typed.index);
    if (p) {
      p.stage = "docker";
      p.attempt = typed.attempt;
      p.stageDone.llm = true;
      p.stageDone.contract = true;
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "validation_failed") {
    const p = getSlot(typed.index);
    if (p) {
      p.stage = "docker";
      p.attempt = typed.attempt;
      p.lastFailure = { stage: "docker", message: "Docker validation failed." };
    }
    return { progress: next };
  }

  if (typed.type === "attempt_failed") {
    const p = getSlot(typed.index);
    if (p) {
      p.attempt = typed.attempt;
      p.lastFailure =
        typed.phase === "validate"
          ? { stage: "docker", message: "Docker validation failed." }
          : { stage: "contract", message: "Contract validation failed." };
    }
    return { progress: next };
  }

  if (typed.type === "problem_validated") {
    const p = getSlot(typed.index);
    if (p) {
      p.stage = "done";
      p.stageDone = { llm: true, contract: true, docker: true };
      p.lastFailure = null;
    }
    return { progress: next };
  }

  if (typed.type === "problem_failed") {
    const p = getSlot(typed.index);
    if (p) p.stage = "failed";
    return { progress: next };
  }

  if (typed.type === "generation_failed") {
    next.error = typed.error || "Generation failed.";
    if (typeof typed.slotIndex === "number") {
      const p = getSlot(typed.slotIndex);
      if (p && p.stage !== "done") p.stage = "failed";
    } else {
      for (const p of next.slots) {
        if (p.stage !== "done") p.stage = "failed";
      }
    }
    return { progress: next };
  }

  return { progress: next };
}

export function renderOverallPercent(p: GenerationProgressState): number {
  const done = p.slots.filter((x) => x.stage === "done").length;
  const total = p.totalSlots || 1;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function renderSlotStatus(p: SlotProgress): string {
  if (p.stage === "queued") return "Queued";
  if (p.stage === "done") return "Done";
  if (p.stage === "failed") return "Failed";
  if (p.lastFailure) return `Retrying… (attempt ${Math.min(3, p.attempt + 1)}/3)`;
  if (p.stage === "llm") return p.attempt ? `Generating (attempt ${p.attempt}/3)` : "Generating";
  if (p.stage === "contract") return p.attempt ? `Validating contract (attempt ${p.attempt}/3)` : "Validating contract";
  if (p.stage === "docker") return p.attempt ? `Validating in Sandbox (attempt ${p.attempt}/3)` : "Validating in Sandbox";
  return "Queued";
}

export function renderSlotPercent(p: SlotProgress): number {
  if (p.stage === "done") return 100;
  if (p.stage === "failed") return 100;
  if (p.stage === "queued") return 0;
  if (p.stage === "llm") return 25;
  if (p.stage === "contract") return 50;
  if (p.stage === "docker") return 75;
  return 0;
}
