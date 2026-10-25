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

  it("counts a resumed tutor session's cost once: Claude's report covers the whole session so far", async () => {
    const usage = usageStore(dir());
    usage.record('c', 'tutor', { input: 10, output: 1, costUsd: 0.261 }, 'sess');
    usage.record('c', 'tutor', { input: 10, output: 1, costUsd: 0.2746 }, 'sess');
    expect(usage.course('c').total.costUsd).toBeCloseTo(0.2746, 6);
    // A crashed turn can report 0; the next turn's total still counts only what's new.
    usage.record('c', 'tutor', { input: 1, output: 1, costUsd: 0 }, 'sess');
    usage.record('c', 'tutor', { input: 1, output: 1, costUsd: 0.3 }, 'sess');
    expect(usage.course('c').total.costUsd).toBeCloseTo(0.3, 6);
  });

  it("counts a resumed setup session's cost once: a proposal after a gate failure continues the last one", () => {
    const usage = usageStore(dir());
    usage.record('c', 'setup', { input: 10, output: 1, costUsd: 0.5 }, 'setup-1');
    usage.record('c', 'setup', { input: 10, output: 1, costUsd: 0.8 }, 'setup-1');
    expect(usage.course('c').kinds.setup!.costUsd).toBeCloseTo(0.8, 6);
  });

  it("counts a relaunched author's session cost once: the relaunch continues the failed attempt's session", () => {
    const usage = usageStore(dir());
    usage.record('c', 'author', { input: 10, output: 1, costUsd: 0.4 }, 'author-1');
    usage.record('c', 'author', { input: 10, output: 1, costUsd: 0.9 }, 'author-1');
    expect(usage.course('c').kinds.author!.costUsd).toBeCloseTo(0.9, 6);
  });

  it('keeps baselines only for tutor and setup sessions, the only ones resumed, so other jobs never push one out', () => {
    const usage = usageStore(dir());
    usage.record('c', 'tutor', { input: 0, output: 0, costUsd: 2 }, 'tutor-1');
    for (let i = 0; i < 150; i++) usage.record('c', 'lesson', { input: 0, output: 0, costUsd: 0.01 }, `lesson-${i}`);
    usage.record('c', 'tutor', { input: 0, output: 0, costUsd: 2.1 }, 'tutor-1');
    expect(usage.course('c').kinds.tutor!.costUsd).toBeCloseTo(2.1, 6);
    expect(Object.keys(JSON.parse(readFileSync(join(usage.dir, 'usage.json'), 'utf8')).sessions)).toEqual(['tutor-1']);
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

});
