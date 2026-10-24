// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { boundOf, live, settle } from './testing/fakes';

type Test = ReturnType<typeof live>;

/** Researches a goal and approves its roadmap: it becomes one of the learner's courses, on screen. */
async function approved(t: Test, topic: string): Promise<string> {
  await t.api.connect('claude');
  const goal = { topic, known: '', depth: 'standard' } as const;
  const r = await settle(() => t.api.research(goal), (x) => x.state !== 'running', 'Research');
  await t.api.approve(r.roadmap!.concepts);
  return t.c.roadmap!.course;
}

/** A promise a fake agent waits on until the test lets it go. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

const ran = (t: Test, kind: string) => t.jobs.ran.filter((j) => j.kind === kind).map(boundOf);
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** React's author job holds the cross-course author turn; Python's author job waits behind it. */
async function queuedBehindAnother() {
  const held = gate();
  const t = live({ author: async (job, usual) => (boundOf(job).startsWith('react') && (await held.opened), usual()) });
  t.c.tracks.push('react@1', 'python@1');
  const react = await approved(t, 'React');
  await settle(async () => ran(t, 'author'), (r) => r.length === 1, "React's author");
  const python = await approved(t, 'Python');
  await settle(async () => ran(t, 'lesson'), (r) => r.includes(python), "Python's lesson");
  await pause();
  expect(ran(t, 'author')).toEqual([react]);
  return { t, held, react, python };
}

describe('live CodemmApi: author targets come from core (§3.2, B6)', () => {
  it('never launches a queued author job whose target went stale while it waited, and stalls nothing', async () => {
    const { t, held, react, python } = await queuedBehindAnother();
    // A check meanwhile leaves the learner stuck on Python's topic: core no longer asks for its activity.
    t.c.stuck = 'python-values';
    held.open();
    await settle(async () => t.c.exercises.has('values-easy-1'), Boolean, "React's activity");
    await pause();
    expect(ran(t, 'author')).toEqual([react]);
    // Python is the course on screen, so its view says whether it stalled.
    expect(t.c.roadmap!.course).toBe(python);
    expect((await t.api.course())!.stalled).toBeUndefined();
  });

  it('runs a queued author job whose target still stands, as before', async () => {
    const { t, held, react, python } = await queuedBehindAnother();
    held.open();
    await settle(async () => ran(t, 'author'), (r) => r.length === 2, "Python's author");
    expect(ran(t, 'author')).toEqual([react, python]);
    await settle(async () => t.c.exercises.has('python-values-easy-1'), Boolean, "Python's activity");
    expect((await t.api.course())!.stalled).toBeUndefined();
  });
});
