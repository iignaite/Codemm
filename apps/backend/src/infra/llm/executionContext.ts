import { AsyncLocalStorage } from "async_hooks";
import type { ResolvedLlmRoutePlan, ResolvedLlmSnapshot } from "./types";
import { ensureRoutePlan } from "./routePlanner";

const llmSnapshotStorage = new AsyncLocalStorage<ResolvedLlmRoutePlan | null>();

export function withResolvedLlmSnapshot<T>(snapshot: ResolvedLlmSnapshot | ResolvedLlmRoutePlan | null, fn: () => Promise<T> | T): Promise<T> | T {
  return llmSnapshotStorage.run(ensureRoutePlan(snapshot), fn);
}

export function getResolvedLlmSnapshot(): ResolvedLlmRoutePlan | null {
  return llmSnapshotStorage.getStore() ?? null;
}
