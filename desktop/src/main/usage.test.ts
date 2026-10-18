// @vitest-environment node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './testing/temp';
import { usageStore } from './usage';

const dir = () => tempDir('codemm-usage-');

describe('usage store', () => {
  it('adds up what the agents reported, per course and job kind', () => {
    const d = dir();
    const usage = usageStore(d);
    usage.record('react-1', 'lesson', { input: 100, output: 10, cachedInput: 60 });
    usage.record('react-1', 'lesson', { input: 50, output: 5 });
    usage.record('react-1', 'author', { input: 7, output: 3, costUsd: 0.25 }, 's1');
    usage.record('python-1', 'research', { input: 1, output: 1 });
    expect(usage.course('react-1')).toEqual({
      kinds: {
        lesson: { input: 150, output: 15, cachedInput: 60, costUsd: 0, runs: 2 },
        author: { input: 7, output: 3, cachedInput: 0, costUsd: 0.25, runs: 1 },
      },
      total: { input: 157, output: 18, cachedInput: 60, costUsd: 0.25, runs: 3 },
    });
    // A new store reads the same file.
    expect(usageStore(d).course('react-1').total.runs).toBe(3);
    expect(usageStore(d).course('unknown')).toEqual({ kinds: {}, total: { input: 0, output: 0, cachedInput: 0, costUsd: 0, runs: 0 } });
  });

  it("counts a resumed Claude session's cost once: its report covers the whole session so far", () => {
    const usage = usageStore(dir());
    usage.record('c', 'tutor', { input: 10, output: 1, costUsd: 0.261 }, 'sess');
    usage.record('c', 'tutor', { input: 10, output: 1, costUsd: 0.2746 }, 'sess');
    expect(usage.course('c').total.costUsd).toBeCloseTo(0.2746, 6);
    // A lower total (a session that started over) adds nothing rather than going back.
    usage.record('c', 'tutor', { input: 1, output: 1, costUsd: 0.1 }, 'sess');
    expect(usage.course('c').total.costUsd).toBeCloseTo(0.2746, 6);
  });

  it('remembers whether the last Claude run counted toward a subscription plan', () => {
    const usage = usageStore(dir());
    expect(usage.plan()).toBeUndefined();
    usage.notePlan(true);
    expect(usage.plan()).toBe(true);
    usage.notePlan(false);
    expect(usageStore(usage.dir).plan()).toBe(false);
  });

  it('writes usage.json atomically with its format_version, and starts over from a file it cannot read', () => {
    const d = dir();
    const usage = usageStore(d);
    usage.record('c', 'setup', { input: 1, output: 2 });
    expect(JSON.parse(readFileSync(join(d, 'usage.json'), 'utf8'))).toMatchObject({ format_version: 1 });
    expect(readdirSync(d)).toEqual(['usage.json']);
    writeFileSync(join(d, 'usage.json'), '{not json');
    expect(usageStore(d).course('c').total.runs).toBe(0);
    writeFileSync(join(d, 'usage.json'), JSON.stringify({ format_version: 9, courses: {} }));
    expect(usageStore(d).course('c').total.runs).toBe(0);
    usageStore(d).record('c', 'setup', { input: 1, output: 1 });
    expect(usageStore(d).course('c').total.runs).toBe(1);
  });

  it('keeps at most 100 sessions for cost', () => {
    const usage = usageStore(dir());
    for (let i = 0; i < 120; i++) usage.record('c', 'tutor', { input: 0, output: 0, costUsd: 0.01 }, `s${i}`);
    expect(Object.keys(JSON.parse(readFileSync(join(usage.dir, 'usage.json'), 'utf8')).sessions)).toHaveLength(100);
  });
});
