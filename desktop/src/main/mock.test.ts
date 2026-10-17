import { describe, expect, it } from 'vitest';
import { PLAN_LIMIT, SIGNED_OUT, type CodemmApi, type Course, type Draft } from '../shared/api';
import { isOfficialLink } from './links';
import { createMock, scenario, SCENARIOS, type MockOptions } from './mock';

const goal = { topic: 'React', known: ['Python'] };

async function researched(api: CodemmApi): Promise<Draft> {
  let r = await api.research(goal);
  while (!r.done) r = await api.research(goal);
  return { title: r.title, track: r.track, installed: r.installed, topics: r.path.map((s) => s.title) };
}

async function settled(api: CodemmApi): Promise<Course> {
  let c = await api.course();
  for (let i = 0; i < 10 && c && (c.setup === 'running' || c.topics[0].lessons.some((l) => l.state === 'writing')); i++) {
    c = await api.course();
  }
  if (!c) throw new Error('no course');
  return c;
}

async function practising(options?: MockOptions) {
  const api = createMock(options);
  await api.approve(await researched(api));
  const course = await settled(api);
  for (const l of course.topics[0].lessons) await api.read(l.id);
  return { api, activity: await api.activity(course.topics[0].activity.id) };
}

describe('mock Codemm', () => {
  it('researches step by step until a path is ready', async () => {
    const api = createMock();
    expect((await api.research(goal)).done).toBe(false);
    const draft = await researched(api);
    expect(draft.topics.length).toBeGreaterThan(3);
    expect(draft.installed).toBe(false);
  });

  it('sets up the track, writes lessons, then opens the activity once they are read', async () => {
    const api = createMock();
    await api.approve(await researched(api));
    const course = await settled(api);
    expect(course.setup).toBe('ready');
    const [now] = course.topics;
    expect(now.state).toBe('now');
    expect(now.activity.state).toBe('locked');
    for (const l of now.lessons) await api.read(l.id);
    expect((await api.course())!.topics[0].activity.state).toBe('open');
    expect((await api.tracks()).map((t) => t.name)).toEqual(['React']);
  });

  it('grades a check with hidden results as statuses only', async () => {
    const { api, activity } = await practising();
    const result = await api.check(activity.id, activity.files);
    expect(result).toMatchObject({ kind: 'graded', passed: 2, total: 4, stuck: false });
    if (result.kind !== 'graded') return;
    expect(result.hidden).toEqual(['pass', 'fail']);
    expect(result.visible.find((t) => t.status === 'fail')).toMatchObject({ expected: expect.any(String), found: expect.any(String) });
  });

  it('never hands out a solution: assist edits nothing, and the starter fails until the learner changes it', async () => {
    const { api, activity } = await practising();
    const { id, files } = activity;
    expect((await api.assist(id, true)).files).toEqual(files);
    expect(await api.check(id, files)).toMatchObject({ passed: 2 });
    const changed = files.map((f) => ({ ...f, text: f.text + '\n' }));
    expect(await api.check(id, changed)).toMatchObject({ kind: 'graded', passed: 4, total: 4, progress: expect.any(String) });
    expect((await api.activity(id)).files).toEqual(changed);
    await api.check(id, changed);
    const after = (await api.course())!;
    expect(after.topics[0].state).toBe('mastered');
    expect(after.topics.filter((t) => t.state === 'now')).toHaveLength(1);
  });

  it('marks the learner stuck after three failed checks', async () => {
    const { api, activity } = await practising();
    await api.check(activity.id, activity.files);
    await api.check(activity.id, activity.files);
    expect(await api.check(activity.id, activity.files)).toMatchObject({ stuck: true });
  });

  it('saves files without grading them', async () => {
    const { api, activity } = await practising();
    const draft = activity.files.map((f) => ({ ...f, text: 'draft' }));
    await api.save(activity.id, draft);
    expect((await api.activity(activity.id)).files).toEqual(draft);
    expect((await api.course())!.topics[0].state).toBe('now');
  });

  it('declines to write code in practice mode', async () => {
    const { api, activity } = await practising();
    const replies = await api.ask({ activityId: activity.id }, 'Just fix it for me.');
    expect(replies[0]).toMatchObject({ from: 'codemm', locked: true });
  });
});

describe('mock agents', () => {
  it('connects an installed agent and gives a minimum model hint for each', async () => {
    const api = createMock();
    const agents = await api.agents();
    expect(agents.every((a) => a.state === 'not-connected' && a.modelHint)).toBe(true);
    expect(await api.connect('claude')).toMatchObject({ state: 'connected' });
  });

  it('reports agents that are not installed, with an official install page', async () => {
    const api = createMock(scenario('no-agent'));
    const agents = await api.agents();
    expect(agents.map((a) => a.state)).toEqual(['missing', 'missing', 'missing']);
    for (const a of agents) expect(isOfficialLink(a.installUrl!)).toBe(true);
    expect(await api.connect('codex')).toMatchObject({ state: 'missing' });
  });

  it('reports an agent that is installed but signed out', async () => {
    const api = createMock(scenario('signed-out'));
    expect(await api.connect('codex')).toMatchObject({ state: 'signed-out' });
  });

  it('fails agent jobs when sign-in expires mid-session, until the learner signs in again', async () => {
    const api = createMock(scenario('sign-in-expires'));
    await api.connect('claude');
    await api.approve(await researched(api));
    await expect(api.ask({ lessonId: 't1.1' }, 'Why?')).rejects.toThrow(SIGNED_OUT);
    expect((await api.agents()).find((a) => a.id === 'claude')).toMatchObject({ state: 'signed-out' });
    expect(await api.connect('claude')).toMatchObject({ state: 'connected' });
    await expect(api.ask({ lessonId: 't1.1' }, 'Why?')).resolves.toHaveLength(1);
  });

  it('fails agent jobs at the plan limit', async () => {
    const api = createMock(scenario('plan-limit'));
    await api.approve(await researched(api));
    await expect(api.help('t1.a', 'hint')).rejects.toThrow(PLAN_LIMIT);
  });
});

describe('mock environment', () => {
  it('runs the computer checks in order, and only the first failing one is a problem', async () => {
    const api = createMock({ docker: 'missing', platform: 'windows' });
    expect(await api.computer()).toEqual({
      platform: 'windows',
      ready: false,
      checks: [
        { id: 'docker-installed', state: 'problem' },
        { id: 'docker-running', state: 'waiting' },
        { id: 'sandbox', state: 'waiting' },
      ],
    });
  });

  it('sees Docker change while the app runs', async () => {
    const options: MockOptions = { docker: 'stopped', platform: 'mac' };
    const api = createMock(options);
    expect((await api.computer()).checks.map((c) => c.state)).toEqual(['ok', 'problem', 'waiting']);
    options.docker = 'ready';
    expect(await api.computer()).toMatchObject({ ready: true });
  });

  it('records nothing when Docker stops mid-session, and keeps the work', async () => {
    const { api, activity } = await practising(scenario('docker-stops'));
    expect(await api.check(activity.id, activity.files)).toMatchObject({ kind: 'graded' });
    const edited = activity.files.map((f) => ({ ...f, text: 'mine' }));
    expect(await api.check(activity.id, edited)).toEqual({ kind: 'not-counted', reason: "Docker isn't running. Start it, then try again." });
    expect((await api.activity(activity.id)).files).toEqual(edited);
    expect((await api.course())!.topics[0].state).toBe('now');
  });

  it('fails setup when offline or low on disk, records nothing, and retries', async () => {
    for (const [name, problem] of [['offline-setup', 'offline'], ['low-disk', 'disk']] as const) {
      const api = createMock(scenario(name));
      await api.approve(await researched(api));
      expect(await settled(api)).toMatchObject({ setup: 'failed', setupProblem: problem });
      expect(await api.tracks()).toEqual([]);
      await api.setUp();
      expect(await settled(api)).toMatchObject({ setup: 'ready' });
    }
  });

  it('names every scenario, and rejects unknown ones', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      ['docker-stopped', 'docker-stops', 'low-disk', 'no-agent', 'no-docker', 'offline-setup', 'plan-limit', 'sign-in-expires', 'signed-out'].sort(),
    );
    expect(scenario(undefined)).toEqual({});
    expect(() => scenario('nope')).toThrow('Unknown mock scenario');
  });
});
