import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A fresh folder under the OS temp folder, removed when the spec file ends. */
export function tempDir(prefix = 'codemm-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Best effort: a folder the app still holds (Windows) is left for the OS.
test.afterAll(() => {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still in use.
    }
  }
});
