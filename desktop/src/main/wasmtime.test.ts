// @vitest-environment node
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wasmtimeIn } from './wasmtime';

describe('the bundled wasmtime (core §4.5)', () => {
  it("is the folder's wasmtime, wasmtime.exe on Windows", () => {
    const seen: string[] = [];
    const exists = (f: string) => (seen.push(f), true);
    expect(wasmtimeIn('/App/wasmtime', 'darwin', exists)).toBe(join('/App/wasmtime', 'wasmtime'));
    expect(wasmtimeIn('C:/App/wasmtime', 'win32', exists)).toBe(join('C:/App/wasmtime', 'wasmtime.exe'));
    expect(seen).toEqual([join('/App/wasmtime', 'wasmtime'), join('C:/App/wasmtime', 'wasmtime.exe')]);
  });

  it('is none when the folder has no wasmtime, as in development before fetching it: then core looks on PATH', () => {
    expect(wasmtimeIn('/dev/vendor/wasmtime/mac-arm64', 'darwin', () => false)).toBeUndefined();
  });
});
