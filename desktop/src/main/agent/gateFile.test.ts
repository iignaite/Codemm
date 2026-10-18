// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readGate, watchGates } from './gateFile';

const file = () => join(mkdtempSync(join(tmpdir(), 'codemm-gates-')), 'job.json');

describe("core's gate file (codemm mcp --progress)", () => {
  it('reads the gate by name, and nothing else', () => {
    const path = file();
    expect(readGate(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ format_version: 1, gate: 'starter' }));
    expect(readGate(path)).toBe('starter');
    for (const bad of ['{', JSON.stringify({ format_version: 2, gate: 'starter' }), JSON.stringify({ format_version: 1, gate: 'hidden/01' }), JSON.stringify({ format_version: 1, gate: 'x'.repeat(5000) })]) {
      writeFileSync(path, bad);
      expect(readGate(path)).toBeUndefined();
    }
  });

  it('never throws when the file cannot be removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codemm-gates-'));
    // A folder in the file's place: removing it as a file fails.
    mkdirSync(join(dir, 'job.json', 'inside'), { recursive: true });
    const watch = watchGates(join(dir, 'job.json'), () => undefined, 10);
    expect(() => watch.clear()).not.toThrow();
    expect(() => watch.stop()).not.toThrow();
  });

  it('hears each gate while it runs, forgets a finished save, and removes the file when stopped', async () => {
    const path = file();
    const heard: string[] = [];
    const watch = watchGates(path, (g) => heard.push(g), 10);
    writeFileSync(path, JSON.stringify({ format_version: 1, gate: 'reference' }));
    await vi.waitFor(() => expect(heard).toContain('reference'));
    watch.clear();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ format_version: 1, gate: 'mutants' }));
    await vi.waitFor(() => expect(heard).toContain('mutants'));
    watch.stop();
    expect(existsSync(path)).toBe(false);
  });
});
