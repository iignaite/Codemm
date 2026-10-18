import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const made: string[] = [];

/** A fresh folder under the OS temp folder, removed when the test file ends. */
export function tempDir(prefix = 'codemm-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes every folder tempDir made. Best effort: a folder still in use (Windows) is left for the OS. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still in use.
    }
  }
}

afterAll(removeTempDirs);
