import type {
  AttemptDiagnostic,
  GenerationRouteSelection,
  GenerationStageTimelineEntry,
} from "../contracts/generationDiagnostics";
import type { GenerationProgressEvent } from "../contracts/generationProgress";

type RunEventRow = { seq: number; type: string; payload_json: string; created_at: string };

type ParsedProgressRow = { seq: number; createdAt: string; event: GenerationProgressEvent };

function parseProgressRows(rows: RunEventRow[]): ParsedProgressRow[] {
  const parsed: ParsedProgressRow[] = [];
  for (const row of rows) {
    if (row.type !== "progress") continue;
    try {
      const event = JSON.parse(row.payload_json) as GenerationProgressEvent;
      if (!event || typeof (event as any).type !== "string") continue;
      parsed.push({ seq: row.seq, createdAt: row.created_at, event });
    } catch {
      // ignore malformed payloads
    }
  }
  return parsed;
}

export function collectAttemptDiagnostics(rows: RunEventRow[]): {
  diagnostics: AttemptDiagnostic[];
  stageTimeline: GenerationStageTimelineEntry[];
  routeSelections: GenerationRouteSelection[];
  timingSummary: {
    llmMs: number;
    dockerMs: number;
    totalStageMs: number;
  };
  progressEvents: GenerationProgressEvent[];
  latestFailure: {
    slotIndex: number;
    attempt: number;
    kind: string;
    message: string;
    remediation: string[];
    final: boolean;
    stage?: "skeleton" | "tests" | "reference" | "validate" | "repair";
    terminationReason?: string;
  } | null;
} {
  const parsedRows = parseProgressRows(rows);
  const progressEvents = parsedRows.map((r) => r.event);
  const diagnostics: AttemptDiagnostic[] = [];
  const stageTimeline: GenerationStageTimelineEntry[] = [];
  const routeSelections: GenerationRouteSelection[] = [];
  const byKey = new Map<string, AttemptDiagnostic>();
  const stageAttempts = new Map<string, number>();
  const timingSummary = { llmMs: 0, dockerMs: 0, totalStageMs: 0 };
  let latestFailure: {
    slotIndex: number;
    attempt: number;
    kind: string;
    message: string;
    remediation: string[];
    final: boolean;
    stage?: "skeleton" | "tests" | "reference" | "validate" | "repair";
    terminationReason?: string;
  } | null = null;

  const keyFor = (slotIndex: number, attempt: number) => `${slotIndex}:${attempt}`;
  const stageKeyFor = (slotIndex: number, stage: string) => `${slotIndex}:${stage}`;

  for (const row of parsedRows) {
    const ev = row.event;
    if (ev.type === "route_selected") {
      routeSelections.push({
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        routeRole: ev.routeRole,
        ...(typeof ev.provider === "string" ? { provider: ev.provider } : {}),
        ...(typeof ev.model === "string" ? { model: ev.model } : {}),
        ...(typeof ev.capability === "string" ? { capability: ev.capability } : {}),
        ...(typeof ev.promptTemplateId === "string" ? { promptTemplateId: ev.promptTemplateId } : {}),
      });
      continue;
    }

    if (ev.type === "slot_stage_started") {
      stageAttempts.set(stageKeyFor(ev.slotIndex, ev.stage), ev.attempt);
      stageTimeline.push({
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        stage: ev.stage,
        attempt: ev.attempt,
        status: "started",
        ...(typeof ev.routeRole === "string" ? { routeRole: ev.routeRole } : {}),
        ...(typeof ev.provider === "string" ? { provider: ev.provider } : {}),
        ...(typeof ev.model === "string" ? { model: ev.model } : {}),
        ...(typeof ev.promptTemplateId === "string" ? { promptTemplateId: ev.promptTemplateId } : {}),
        ...(typeof ev.startedAt === "string" ? { startedAt: ev.startedAt } : {}),
      });
      continue;
    }

    if (ev.type === "slot_stage_finished") {
      if (typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs) && ev.durationMs >= 0) {
        timingSummary.totalStageMs += ev.durationMs;
        if (ev.stage === "validate") timingSummary.dockerMs += ev.durationMs;
        else timingSummary.llmMs += ev.durationMs;
      }
      stageTimeline.push({
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        stage: ev.stage,
        attempt: ev.attempt,
        status: ev.status,
        ...(typeof ev.routeRole === "string" ? { routeRole: ev.routeRole } : {}),
        ...(typeof ev.provider === "string" ? { provider: ev.provider } : {}),
        ...(typeof ev.model === "string" ? { model: ev.model } : {}),
        ...(typeof ev.promptTemplateId === "string" ? { promptTemplateId: ev.promptTemplateId } : {}),
        ...(typeof ev.startedAt === "string" ? { startedAt: ev.startedAt } : {}),
        ...(typeof ev.endedAt === "string" ? { endedAt: ev.endedAt } : {}),
        ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
        ...(typeof ev.artifactHash === "string" ? { artifactHash: ev.artifactHash } : {}),
        ...(typeof ev.failureKind === "string" ? { failureKind: ev.failureKind } : {}),
        ...(typeof ev.message === "string" ? { message: ev.message } : {}),
        ...(typeof ev.exitCode === "number" ? { exitCode: ev.exitCode } : {}),
        ...(typeof ev.timedOut === "boolean" ? { timedOut: ev.timedOut } : {}),
      });
      if (ev.status === "failed") {
        latestFailure = {
          slotIndex: ev.slotIndex,
          attempt: ev.attempt,
          kind: ev.failureKind ?? "unknown",
          message: ev.message ?? `Stage ${ev.stage} failed.`,
          remediation: [],
          final: false,
          stage: ev.stage,
        };
      }
      continue;
    }

    if (ev.type === "slot_escalated") {
      stageTimeline.push({
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        stage: ev.stage,
        attempt: stageAttempts.get(stageKeyFor(ev.slotIndex, ev.stage)) ?? 1,
        status: "escalated",
        routeRole: ev.routeRole,
        ...(typeof ev.fromModel === "string" ? { fromModel: ev.fromModel } : {}),
        ...(typeof ev.toModel === "string" ? { toModel: ev.toModel } : {}),
        reason: ev.reason,
      });
      continue;
    }

    if (ev.type === "slot_failed_terminal") {
      const attempt = stageAttempts.get(stageKeyFor(ev.slotIndex, ev.stage)) ?? 1;
      stageTimeline.push({
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        stage: ev.stage,
        attempt,
        status: "terminal",
        ...(typeof ev.routeRole === "string" ? { routeRole: ev.routeRole } : {}),
        failureKind: ev.failureKind,
        message: ev.message,
        terminationReason: ev.terminationReason,
      });
      latestFailure = {
        slotIndex: ev.slotIndex,
        attempt,
        kind: ev.failureKind,
        message: ev.message,
        remediation: [ev.terminationReason],
        final: true,
        stage: ev.stage,
        terminationReason: ev.terminationReason,
      };
      continue;
    }

    if (ev.type === "slot_attempt_summary") {
      const key = keyFor(ev.slotIndex, ev.attempt);
      const diagnostic: AttemptDiagnostic = {
        ts: row.createdAt,
        slotIndex: ev.slotIndex,
        attempt: ev.attempt,
        maxAttempts: ev.maxAttempts,
        phase: ev.phase,
        status: ev.status,
        ...(ev.kind ? { kind: ev.kind } : {}),
        ...(typeof ev.message === "string" ? { message: ev.message } : {}),
        ...(Array.isArray(ev.remediation) ? { remediation: ev.remediation } : {}),
        ...(typeof ev.llmOutputHash === "string" ? { llmOutputHash: ev.llmOutputHash } : {}),
        ...(ev.llm ? { llm: ev.llm } : {}),
        ...(ev.slotIntent ? { slotIntent: ev.slotIntent } : {}),
        ...(ev.artifactSet ? { artifactSet: ev.artifactSet } : {}),
      };
      byKey.set(key, diagnostic);
      diagnostics.push(diagnostic);
      continue;
    }

    if (ev.type === "slot_failure_diagnostic") {
      const key = keyFor(ev.slotIndex, ev.attempt);
      const existing = byKey.get(key);
      if (existing) {
        existing.kind = ev.kind;
        existing.message = ev.message;
        existing.remediation = ev.remediation;
      } else {
        const fallback: AttemptDiagnostic = {
          ts: row.createdAt,
          slotIndex: ev.slotIndex,
          attempt: ev.attempt,
          maxAttempts: ev.attempt,
          phase: "generate",
          status: "failed",
          kind: ev.kind,
          message: ev.message,
          remediation: ev.remediation,
        };
        byKey.set(key, fallback);
        diagnostics.push(fallback);
      }
      latestFailure = {
        slotIndex: ev.slotIndex,
        attempt: ev.attempt,
        kind: ev.kind,
        message: ev.message,
        remediation: ev.remediation,
        final: ev.final,
      };
      continue;
    }

    if (ev.type === "slot_repair_applied") {
      const key = keyFor(ev.slotIndex, ev.attempt);
      const existing = byKey.get(key);
      if (existing) {
        existing.repairStrategy = ev.strategy;
      } else {
        const fallback: AttemptDiagnostic = {
          ts: row.createdAt,
          slotIndex: ev.slotIndex,
          attempt: ev.attempt,
          maxAttempts: ev.attempt,
          phase: "generate",
          status: "failed",
          repairStrategy: ev.strategy,
          ...(typeof ev.detail === "string" ? { message: ev.detail } : {}),
        };
        byKey.set(key, fallback);
        diagnostics.push(fallback);
      }
      continue;
    }
  }

  return { diagnostics, stageTimeline, routeSelections, timingSummary, progressEvents, latestFailure };
}
