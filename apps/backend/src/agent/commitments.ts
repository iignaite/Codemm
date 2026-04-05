import type { ActivitySpec } from "../contracts/activitySpec";
import { REQUIRED_CONFIDENCE } from "./policy";

export type Commitment = {
  field: keyof ActivitySpec;
  value: unknown;
  confidence: number;
  source: "explicit" | "implicit";
  locked: boolean;
};

export type CommitmentStore = Partial<Record<keyof ActivitySpec, Commitment>>;

export function parseCommitmentsJson(json: string | null | undefined): CommitmentStore {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return {};
    const store: CommitmentStore = {};
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const field = (item as any).field as keyof ActivitySpec;
      if (typeof field !== "string" || !field) continue;
      const confidence = (item as any).confidence;
      const source = (item as any).source;
      const locked = (item as any).locked;
      store[field] = {
        field,
        value: (item as any).value,
        confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0,
        source: source === "explicit" ? "explicit" : "implicit",
        locked: locked === true,
      };
    }
    return store;
  } catch {
    return {};
  }
}

export function serializeCommitments(store: CommitmentStore): string {
  const items = Object.values(store)
    .filter(Boolean)
    .sort((a, b) => String(a!.field).localeCompare(String(b!.field)));
  return JSON.stringify(items);
}

export function listCommitments(store: CommitmentStore): Commitment[] {
  return Object.values(store)
    .filter((c): c is Commitment => Boolean(c))
    .sort((a, b) => String(a.field).localeCompare(String(b.field)));
}

export function isFieldLocked(store: CommitmentStore, field: keyof ActivitySpec): boolean {
  return store[field]?.locked === true;
}

export function shouldLockCommitment(field: keyof ActivitySpec, confidence: number, source: Commitment["source"]): boolean {
  if (source !== "explicit") return false;
  const threshold = (REQUIRED_CONFIDENCE as any)[field];
  const required = typeof threshold === "number" ? threshold : 1;
  return confidence >= required;
}

export function upsertCommitment(store: CommitmentStore, next: Omit<Commitment, "locked">): CommitmentStore {
  const normalizedConfidence = Number.isFinite(next.confidence) ? Math.max(0, Math.min(1, next.confidence)) : 0;
  const locked = shouldLockCommitment(next.field, normalizedConfidence, next.source);
  return {
    ...store,
    [next.field]: {
      field: next.field,
      value: next.value,
      confidence: normalizedConfidence,
      source: next.source,
      locked,
    },
  };
}

export function removeCommitment(store: CommitmentStore, field: keyof ActivitySpec): CommitmentStore {
  if (!store[field]) return store;
  const next: CommitmentStore = { ...store };
  delete next[field];
  return next;
}
