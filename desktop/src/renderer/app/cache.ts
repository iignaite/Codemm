import type { CodemmApi } from '../../shared/api';

const caches = new WeakMap<CodemmApi, Map<string, unknown>>();

/** A per-Codemm cache, so screens can show what they last loaded at once. */
export function cacheFor<T>(api: CodemmApi, name: string): Map<string, T> {
  let all = caches.get(api);
  if (!all) caches.set(api, (all = new Map()));
  let cache = all.get(name) as Map<string, T> | undefined;
  if (!cache) all.set(name, (cache = new Map()));
  return cache;
}
