// The CodemmApi contract: what the mock (CODEMM_MOCK, the renderer's tests) and the live API (over a fake core and
// fake agents) both promise, checked by one suite against each. Only the public API is used, through the same steps.
import { describe, expect, it } from 'vitest';
import { CHANGED, type Activity, type CodemmApi, type CourseView, type Roadmap } from '../../shared/api';

export interface Subject {
  api: CodemmApi;
  /** Docker stops: Try it and Check can't run. */
  stopDocker(): void;
}

const GOAL = { topic: 'React', known: '', depth: 'standard' as const };
const pause = () => new Promise((r) => setTimeout(r, 5));

/** Reads until `done`, as a screen polls; both APIs move background work on as they're read or as time passes. */
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (done(value)) return value;
    await pause();
  }
  throw new Error(`never settled: ${what}`);
}

const course = (api: CodemmApi, done: (c: CourseView) => boolean, what: string) => poll(async () => (await api.course())!, (c) => c !== null && done(c), what);

async function research(api: CodemmApi): Promise<Roadmap> {
  await api.connect('claude');
  const r = await poll(() => api.research(GOAL), (x) => x.state !== 'running', 'research');
  expect(r.state).toBe('done');
  return r.roadmap!;
}

/** A course set up, with the first topic's lessons read and its activity open. */
async function practise(api: CodemmApi): Promise<Activity> {
  const roadmap = await research(api);
  await api.approve(roadmap.concepts);
  const consent = await course(api, (c) => c.setup === 'consent', 'setup consent');
  await api.install(consent.proposal!.digest);
  const ready = await course(api, (c) => c.setup === 'ready' && c.topics[0].lessons.length > 0 && c.topics[0].lessons.every((l) => l.state !== 'writing'), 'lessons written');
  for (const l of ready.topics[0].lessons) await api.markRead(l.id);
  const open = await course(api, (c) => c.topics[0].activity === 'open', 'activity open');
  return api.activity(open.topics[0].id);
}

export function codemmApiContract(name: string, make: () => Subject) {
  describe(`the CodemmApi contract: ${name}`, () => {
    it('lists Claude Code, Codex and Cursor, in that order', async () => {
      expect((await make().api.agents()).map((a) => a.id)).toEqual(['claude', 'codex', 'cursor']);
    });

    it('has no course and no draft before research', async () => {
      const { api } = make();
      expect(await api.course()).toBeNull();
      expect(await api.draft()).toBeNull();
    });

    it('keeps a researched roadmap a draft until it is approved, and then has nothing to edit', async () => {
      const { api } = make();
      const roadmap = await research(api);
      expect(await api.course()).toBeNull();
      expect(await api.draft()).toMatchObject({ goal: roadmap.goal, concepts: roadmap.concepts });
      await api.approve(roadmap.concepts);
      expect(await api.draft()).toBeNull();
      expect((await api.course())!.topics.map((t) => t.id)).toEqual(roadmap.concepts.map((c) => c.id));
      await expect(api.saveDraft(roadmap.concepts)).rejects.toThrow();
    });

    it('saves a learner file with its digest, and refuses a stale digest with CHANGED', async () => {
      const { api } = make();
      const activity = await practise(api);
      const file = activity.files[0];
      const digest = await api.saveFile(activity.id, file.path, `${file.text}\n`, file.digest);
      expect(digest).not.toBe(file.digest);
      await expect(api.saveFile(activity.id, file.path, 'again', file.digest)).rejects.toThrow(CHANGED);
    });

    it('grades a check, with hidden results as an index and a status only', async () => {
      const { api } = make();
      const activity = await practise(api);
      const result = await api.check(activity.id, 'contract-run');
      expect(result.kind).toBe('graded');
      if (result.kind !== 'graded') return;
      const hidden = result.tests.filter((t) => t.hidden);
      expect(hidden.length).toBeGreaterThan(0);
      for (const t of hidden) expect(Object.keys(t).sort()).toEqual(['hidden', 'index', 'status']);
    });

    it('says Try it and Check were not counted when Docker is down', async () => {
      const subject = make();
      const activity = await practise(subject.api);
      subject.stopDocker();
      expect(await subject.api.tryIt(activity.id, 'contract-try')).toEqual({ kind: 'not-counted', reason: expect.any(String) });
      expect(await subject.api.check(activity.id, 'contract-check')).toEqual({ kind: 'not-counted', reason: expect.any(String) });
    });

    it('sends check progress until the listener stops listening', async () => {
      const { api } = make();
      const activity = await practise(api);
      const heard: unknown[] = [];
      const off = api.onCheckProgress((p) => heard.push(p));
      await api.tryIt(activity.id, 'contract-progress');
      expect(heard.length).toBeGreaterThan(0);
      off();
      const before = heard.length;
      await api.tryIt(activity.id, 'contract-progress-2');
      expect(heard).toHaveLength(before);
    });

    it('answers a question as Codemm', async () => {
      const { api } = make();
      const activity = await practise(api);
      const reply = await api.ask({ activityId: activity.id }, 'Why?');
      expect(reply.length).toBeGreaterThan(0);
      expect(reply.every((m) => m.from === 'codemm' && m.text.length > 0)).toBe(true);
    });

    it('defers a skipped topic without mastering it', async () => {
      const { api } = make();
      const activity = await practise(api);
      await api.skip(activity.concept);
      const topic = (await api.course())!.topics.find((t) => t.id === activity.concept)!;
      expect(topic.state).not.toBe('mastered');
    });
  });
}
