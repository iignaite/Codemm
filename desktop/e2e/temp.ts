import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A fresh folder under the OS temp folder. Each spec removes its own with `test.afterAll(removeTempDirs)`. */
export function tempDir(prefix = 'codemm-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * Removes every folder tempDir made. Each spec registers it itself: Playwright loads a helper once per worker, so a
 * hook the helper registered would attach to the first spec only. Best effort: a folder still in use is left.
 */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still in use.
    }
  }
}
