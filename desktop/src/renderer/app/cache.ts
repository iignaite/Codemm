import type { CodemmApi } from '../../shared/api';

/**
 * What a screen last loaded, so it can show it at once next time.
 * `clear()` also drops reads that started before it, so a slow, older read
 * can't put stale data back.
 */
export class Cache<T> {
  private entries = new Map<string, T>();
  private generation = 0;

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  /** Call before a read; pass the result to `set` with the read's value. */
  version(): number {
    return this.generation;
  }

  set(key: string, value: T, version: number): void {
    if (version === this.generation) this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
    this.generation++;
  }
}

const caches = new WeakMap<CodemmApi, Map<string, Cache<unknown>>>();

/** One cache per Codemm instance and name. */
export function cacheFor<T>(api: CodemmApi, name: string): Cache<T> {
  let all = caches.get(api);
  if (!all) caches.set(api, (all = new Map()));
  let cache = all.get(name);
  if (!cache) all.set(name, (cache = new Cache<unknown>()));
  return cache as Cache<T>;
}
