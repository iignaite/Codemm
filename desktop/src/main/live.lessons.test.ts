// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { desktopState } from './state';
import { boundOf, coreError, live, practising, researched, settle, until } from './testing/fakes';

async function lessonsOnly() {
  const t = live({ roadmap: (job) => {
    Object.assign(t.c.courses.get(boundOf(job))!, { style: 'io', track: 'history@1' });
    return {};
  }, research: (job) => {
    t.c.roadmap = { course: boundOf(job), goal: 'History', style: 'none', concepts: [{ id: 'a', title: 'A', requires: [] }] };
    return {};
  } });
  await t.api.connect('claude');
  const r = await settle(() => t.api.research({ topic: 'History', known: '', depth: 'standard', practice: 'none' }), (r) => r.state === 'done', 'Research');
  await t.api.approve(r.roadmap!.concepts);
  await until(t.api, (c) => c.topics[0].lessons.length > 0 && c.topics[0].lessons[0].state === 'ready');
  return t;
}

describe('lessons only', () => {
  it('passes the choice to research, writes lessons without setup or author jobs, and finishes on reads', async () => {
    const t = await lessonsOnly();
    expect(t.jobs.ran[0].brief).toContain('Save style: none and no track.');
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'review', 'lesson']);
    const c = (await t.api.course())!;
    await t.api.markRead(c.topics[0].lessons[0].id);
    expect(await t.api.course()).toMatchObject({ done: true, activities: false });
  });
  it('switches off and restores the previous style on a track offering both, preserving reads', async () => {
    const t = live();
    await practising(t);
    t.c.roadmap!.style = 'unit';
    t.app.listTracks = () => [{ track: 'react@1', styles: ['io', 'unit'], files: ['main.c'] }];
    const reads = [...t.c.reads];
    const jobs = t.jobs.ran.length;
    await t.api.setActivities(false);
    expect(t.c.roadmap).toMatchObject({ style: 'none', track: 'react@1' });
    expect((await t.api.course())!.activities).toBe(false);
    expect(t.jobs.ran.slice(jobs).every((j) => j.kind === 'lesson')).toBe(true);
    await t.api.setActivities(true);
    expect(t.c.roadmap).toMatchObject({ style: 'unit', track: 'react@1' });
    expect([...t.c.reads]).toEqual(reads);
  });
  it('runs a roadmap job when activities are turned on without a track', async () => {
    const t = await lessonsOnly();
    await t.api.setActivities(true);
    expect(t.jobs.ran.find((j) => j.kind === 'roadmap')!.brief).toContain('Turn on graded coding activities: choose a track and a style for this course.');
    await until(t.api, (c) => c.setup === 'consent');
    expect(t.jobs.ran.some((j) => j.kind === 'setup')).toBe(true);
  });
});

it('stops a running author before turning activities off and does not restart it', async () => {
  const t = live({ author: (job) => new Promise((resolve) => {
    job.signal!.addEventListener('abort', () => resolve({ ok: false, text: [] }), { once: true });
  }) });
  t.c.tracks.push('react@1');
  await t.api.connect('claude');
  const goal = { topic: 'React', known: '', depth: 'standard', practice: 'code' } as const;
  const r = await settle(() => t.api.research(goal), (r) => r.state === 'done', 'Research');
  await t.api.approve(r.roadmap!.concepts);
  await settle(async () => t.jobs.ran.some((j) => j.kind === 'author'), Boolean, 'Author');
  await t.api.setActivities(false);
  expect(t.jobs.ran.find((j) => j.kind === 'author')!.signal!.aborted).toBe(true);
  expect(t.jobs.ran.filter((j) => j.kind === 'author')).toHaveLength(1);
  expect(await t.api.course()).toMatchObject({ activities: false, setup: 'ready' });
});

it('does not share setup progress or failures with a course whose activities are off', async () => {
  let finish!: (out: { ok: false; problem: 'failed'; text: string[] }) => void;
  const t = live({ setup: () => new Promise((resolve) => { finish = resolve; }) });
  const r = await researched(t);
  await t.api.approve(r.roadmap!.concepts);
  await settle(async () => Boolean(finish), Boolean, 'Setup');
  const first = t.c.roadmap!.course;
  t.c.courses.set('other', { ...t.c.roadmap!, course: 'other' });
  desktopState(t.dir).update((s) => ({ ...s, courses: [first, 'other'] }));
  await t.api.setActivities(false);
  expect((await t.api.jobProgress()).some((j) => j.kind === 'setup')).toBe(false);
  finish({ ok: false, problem: 'failed', text: [] });
  await t.api.switchCourse('other');
  await until(t.api, (c) => Boolean(c.stalled));
  await t.api.switchCourse(first);
  expect(await t.api.course()).not.toHaveProperty('stalled');
});

it('researches a quiz, starts no setup, and restores quiz after activities are switched off', async () => {
  const t = live({ research: (job) => {
    t.c.roadmap = { course: boundOf(job), goal: 'Judgment', style: 'quiz', concepts: [{ id: 'a', title: 'A', requires: [] }] };
    return {};
  } });
  await t.api.connect('claude');
  const r = await settle(() => t.api.research({ topic: 'Judgment', known: '', depth: 'standard', practice: 'quiz' }), (r) => r.state === 'done', 'Research');
  expect(t.jobs.ran[0].brief).toContain('Save style: quiz and no track.');
  await t.api.approve(r.roadmap!.concepts);
  await until(t.api, (c) => c.topics[0].lessons.length > 0);
  expect((await t.api.course())!.setup).toBe('ready');
  await t.api.setActivities(false);
  await t.api.setActivities(true);
  expect(t.c.roadmap).toMatchObject({ style: 'quiz' });
  expect(t.c.roadmap).not.toHaveProperty('track');
  expect(t.jobs.ran.some((j) => j.kind === 'setup' || j.kind === 'roadmap')).toBe(false);

it("keeps a new course's draft when another course's Activities switch is used", async () => {
  const t = live();
  await practising(t);
  const first = t.c.roadmap!.course;
  // A second course researched but not approved yet: the workspace's draft.
  const second = await settle(() => t.api.research({ topic: 'Python', known: '', depth: 'standard', practice: 'code' }), (r) => r.state === 'done', 'Research');
  expect(t.c.active).not.toBe(first);
  await t.api.setActivities(false);
  expect(t.c.courses.get(first)).toMatchObject({ style: 'none' });
  expect(await t.api.draft()).toMatchObject({ title: second.roadmap!.title });
});

it('refuses the switch while a roadmap job is changing the course, whose save would undo it', async () => {
  let finish!: () => void;
  const t = live({ roadmap: () => new Promise((resolve) => { finish = () => resolve({}); }) });
  await practising(t);
  const easier = t.api.easier(t.c.roadmap!.concepts[0].id);
  await settle(async () => Boolean(finish), Boolean, 'Roadmap job');
  await expect(t.api.setActivities(false)).rejects.toThrow('The roadmap is changing. Try again in a moment.');
  finish();
  await easier;
});

it('asks the roadmap job for a style when activities come on with a track but no remembered style', async () => {
  const t = live({ roadmap: (job) => {
    Object.assign(t.c.courses.get(boundOf(job))!, { style: 'io' });
    return {};
  } });
  await practising(t);
  const course = t.c.roadmap!.course;
  t.c.courses.set(course, { ...t.c.roadmap!, style: 'none', track: 'nowhere@1' });
  await t.api.setActivities(true);
  expect(t.jobs.ran.at(-1)!.kind).toBe('roadmap');
  expect(t.c.courses.get(course)).toMatchObject({ style: 'io' });
});

it("keeps setup progress working when another course's record is damaged", async () => {
  const t = live({ setup: () => new Promise(() => {}) });
  const r = await researched(t);
  await t.api.approve(r.roadmap!.concepts);
  await settle(async () => (await t.api.jobProgress()).some((j) => j.kind === 'setup'), Boolean, 'Setup');
  desktopState(t.dir).update((s) => ({ ...s, courses: [...(s.courses ?? []), 'broken'] }));
  const getRoadmap = t.app.getRoadmap;
  t.app.getRoadmap = (ws, course, ...rest) => {
    if (course === 'broken') throw coreError("Codemm's record /h/courses/broken/course.json is damaged.", 'damaged');
    return getRoadmap(ws, course, ...rest);
  };
  expect((await t.api.jobProgress()).some((j) => j.kind === 'setup')).toBe(true);
});
