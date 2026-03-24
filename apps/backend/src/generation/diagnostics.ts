import type { AttemptDiagnostic } from "../contracts/generationDiagnostics";
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
  progressEvents: GenerationProgressEvent[];
  latestFailure: {
    slotIndex: number;
    attempt: number;
    kind: string;
    message: string;
    remediation: string[];
    final: boolean;
  } | null;
} {
  const parsedRows = parseProgressRows(rows);
  const progressEvents = parsedRows.map((r) => r.event);
  const diagnostics: AttemptDiagnostic[] = [];
  const byKey = new Map<string, AttemptDiagnostic>();
  let latestFailure: {
    slotIndex: number;
    attempt: number;
    kind: string;
    message: string;
    remediation: string[];
    final: boolean;
  } | null = null;

  const keyFor = (slotIndex: number, attempt: number) => `${slotIndex}:${attempt}`;

  for (const row of parsedRows) {
    const ev = row.event;
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

  return { diagnostics, progressEvents, latestFailure };
}

