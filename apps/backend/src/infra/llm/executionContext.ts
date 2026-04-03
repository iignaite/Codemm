import { AsyncLocalStorage } from "async_hooks";
import type { ResolvedLlmSnapshot } from "./types";

const llmSnapshotStorage = new AsyncLocalStorage<ResolvedLlmSnapshot | null>();

export function withResolvedLlmSnapshot<T>(snapshot: ResolvedLlmSnapshot | null, fn: () => Promise<T> | T): Promise<T> | T {
  return llmSnapshotStorage.run(snapshot, fn);
}

export function getResolvedLlmSnapshot(): ResolvedLlmSnapshot | null {
  return llmSnapshotStorage.getStore() ?? null;
}
