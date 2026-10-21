// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GATES, jobTracker } from './progress';

const clock = () => {
  let t = 1000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
};

describe('job progress (§4.11)', () => {
  it('starts at the first stage, and moves on once the agent is up', () => {
    const c = clock();
    const t = jobTracker('lesson', { id: 'job-1', concept: 'values', now: c.now });
    expect(t.snapshot()).toEqual({ job: 'job-1', kind: 'lesson', concept: 'values', stage: 0, steps: [], count: 0, thinking: true, elapsedMs: 0, idleMs: 0 });
    c.pass(2000);
    t.event({ type: 'session', id: 's1' });
    expect(t.snapshot()).toMatchObject({ stage: 1, elapsedMs: 2000, idleMs: 0 });
  });

  it("reaches the save stage when the job's save is called, and shows Codemm's steps", () => {
    const t = jobTracker('author', { id: 'job-1' });
    t.event({ type: 'session', id: 's1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.next_step' });
    t.event({ type: 'progress', step: { kind: 'step', label: 'Checking the next step' } });
    t.event({ type: 'tool_result', id: 'c1', error: false });
    // Once it has its target, the author writes.
    expect(t.snapshot()).toMatchObject({ stage: 1, steps: [{ kind: 'step', label: 'Writing the exercise' }, { kind: 'step', label: 'Checking the next step' }] });
    t.event({ type: 'tool_call', id: 'c2', name: 'codemm.save_exercise' });
    t.event({ type: 'progress', step: { kind: 'step', label: 'Codemm is checking the exercise' } });
    expect(t.snapshot()).toMatchObject({ stage: 2, count: 3, steps: [{ kind: 'step', label: 'Codemm is checking the exercise' }, { kind: 'step', label: 'Writing the exercise' }, { kind: 'step', label: 'Checking the next step' }] });
  });

  it("isn't the agent thinking while one of Codemm's tools runs", () => {
    const t = jobTracker('author', { id: 'job-1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_exercise' });
    expect(t.snapshot().thinking).toBe(false);
    t.event({ type: 'tool_result', id: 'c1', error: false });
    expect(t.snapshot().thinking).toBe(true);
  });

  it('counts idle time from the last event', () => {
    const c = clock();
    const t = jobTracker('tutor', { id: 'job-1', now: c.now });
    c.pass(1000);
    t.event({ type: 'text', text: 'Hm.' });
    c.pass(500);
    expect(t.snapshot()).toMatchObject({ elapsedMs: 1500, idleMs: 500 });
  });

  it('goes back to writing after a failed save, and says it is trying again', () => {
    const t = jobTracker('lesson', { id: 'job-1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_lesson' });
    t.event({ type: 'tool_result', id: 'c1', error: true, text: 'bad' });
    expect(t.snapshot()).toMatchObject({ stage: 1, retry: { attempt: 2, of: 3 } });
    t.event({ type: 'tool_call', id: 'c2', name: 'codemm.save_lesson' });
    t.event({ type: 'tool_result', id: 'c2', error: true });
    expect(t.snapshot().retry).toEqual({ attempt: 3, of: 3 });
  });

  it('goes back to the second stage when a roadmap save is rejected, with no bounded retry', () => {
    for (const kind of ['research', 'roadmap'] as const) {
      const t = jobTracker(kind, { id: 'job-1' });
      t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_roadmap' });
      t.event({ type: 'tool_result', id: 'c1', error: true });
      expect(t.snapshot()).toMatchObject({ stage: 1 });
      expect(t.snapshot().retry).toBeUndefined();
    }
  });

  it('counts failed saves afresh after a relaunch, as the runner does', () => {
    const t = jobTracker('author', { id: 'job-1' });
    for (const id of ['c1', 'c2', 'c3']) {
      t.event({ type: 'tool_call', id, name: 'codemm.save_exercise' });
      t.event({ type: 'tool_result', id, error: true });
    }
    t.relaunch();
    t.event({ type: 'tool_call', id: 'c4', name: 'codemm.save_exercise' });
    t.event({ type: 'tool_result', id: 'c4', error: true });
    expect(t.snapshot().retry).toEqual({ attempt: 2, of: 3 });
  });

  it('starts over on a relaunch, as attempt 2 of 2', () => {
    const t = jobTracker('research', { id: 'job-1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_roadmap' });
    t.relaunch();
    expect(t.snapshot()).toMatchObject({ stage: 0, retry: { attempt: 2, of: 2 }, thinking: true });
  });

  it('keeps the latest 8 steps, newest first, and counts them all', () => {
    const t = jobTracker('research', { id: 'job-1' });
    for (let i = 1; i <= 10; i++) t.event({ type: 'progress', step: { kind: 'search', query: `q${i}` } });
    const s = t.snapshot();
    expect(s.count).toBe(10);
    expect(s.steps.map((x) => (x.kind === 'search' ? x.query : ''))).toEqual(['q10', 'q9', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3']);
  });

  it('shows a page as host and path only, and drops a step the filter holds back', () => {
    const t = jobTracker('research', { id: 'job-1', shows: (text) => !text.includes('SECRET') });
    t.event({ type: 'progress', step: { kind: 'read', url: 'react.dev/learn', href: 'https://react.dev/learn?x=1' } });
    t.event({ type: 'progress', step: { kind: 'search', query: 'SECRET answer' } });
    t.event({ type: 'progress', step: { kind: 'read', url: 'example.com/a', href: 'https://example.com/a?SECRET' } });
    expect(t.snapshot()).toMatchObject({ count: 1, steps: [{ kind: 'read', url: 'react.dev/learn' }] });
  });

  it("shows web searches and pages for research only: another job's agent may still search (Codex)", () => {
    for (const kind of ['author', 'lesson', 'tutor', 'setup', 'roadmap'] as const) {
      const t = jobTracker(kind, { id: 'job-1' });
      t.event({ type: 'progress', step: { kind: 'search', query: 'reverse a linked list solution' } });
      t.event({ type: 'progress', step: { kind: 'read', url: 'example.com/answer', href: 'https://example.com/answer' } });
      t.event({ type: 'progress', step: { kind: 'step', label: 'Saving the lesson' } });
      expect(t.snapshot()).toMatchObject({ count: 1, steps: [{ kind: 'step', label: 'Saving the lesson' }] });
    }
  });

  it('a setup job stays on proposing; the build and its checks come later', () => {
    const t = jobTracker('setup', { id: 'job-1' });
    t.event({ type: 'session', id: 's1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_track' });
    expect(t.snapshot().stage).toBe(0);
  });

  it("follows Codemm's own work, such as a setup's build, which isn't the agent thinking", () => {
    const t = jobTracker('setup', { id: 'job-1' });
    t.reach(1);
    expect(t.snapshot()).toMatchObject({ stage: 1, thinking: false });
  });

  it("carries a real fraction for Codemm's own work: a build's steps", () => {
    const t = jobTracker('setup', { id: 'job-1' });
    t.reach(1, { done: 3, total: 7 });
    expect(t.snapshot()).toMatchObject({ stage: 1, part: { done: 3, total: 7 } });
    t.reach(2);
    expect(t.snapshot().part).toBeUndefined();
  });

  it("names the exercise gates in the learner's words, never the gates' own", () => {
    for (const label of Object.values(GATES)) expect(label).not.toMatch(/reference|starter|broken|mutant/i);
  });

  it("shows which exercise gate runs, as a step and 1 to 3 of 3, until the save's result", () => {
    const t = jobTracker('author', { id: 'job-1' });
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_exercise' });
    t.gate('starter');
    expect(t.snapshot()).toMatchObject({ stage: 2, part: { done: 2, total: 3 }, steps: [{ kind: 'step', label: "Codemm is checking that the exercise isn't solved yet" }], thinking: false });
    t.gate('starter');
    expect(t.snapshot().count).toBe(1);
    t.event({ type: 'tool_result', id: 'c1', error: true });
    expect(t.snapshot().part).toBeUndefined();
  });

  it('ignores a gate when no save runs: a file left by an earlier attempt', () => {
    const t = jobTracker('author', { id: 'job-1' });
    t.gate('mutants');
    expect(t.snapshot().part).toBeUndefined();
    t.event({ type: 'tool_call', id: 'c1', name: 'codemm.save_exercise' });
    expect(t.saving()).toBe(true);
    t.relaunch();
    expect(t.saving()).toBe(false);
    t.gate('mutants');
    expect(t.snapshot().part).toBeUndefined();
  });

  it('starts as a retry when it is one, such as another setup proposal', () => {
    expect(jobTracker('setup', { id: 'job-1', retry: { attempt: 2, of: 3 } }).snapshot().retry).toEqual({ attempt: 2, of: 3 });
  });

  it('a tutor turn has one stage', () => {
    const t = jobTracker('tutor', { id: 'job-1' });
    t.event({ type: 'session', id: 's1' });
    expect(t.snapshot().stage).toBe(0);
  });

  it('ignores events it does not know', () => {
    const t = jobTracker('tutor', { id: 'job-1' });
    t.event({ type: 'usage', tokens: 3 } as never);
    expect(t.snapshot().count).toBe(0);
  });
});
