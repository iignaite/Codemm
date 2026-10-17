import { describe, expect, it } from 'vitest';
import type { CodemmApi, Course, Draft } from '../shared/api';
import { createMock } from './mock';

const goal = { topic: 'React', known: ['Python'] };

async function researched(api: CodemmApi): Promise<Draft> {
  let r = await api.research(goal);
  while (!r.done) r = await api.research(goal);
  return { title: r.title, track: r.track, installed: r.installed, runsPerTopic: r.runsPerTopic, topics: r.path.map((s) => s.title) };
}

async function settled(api: CodemmApi): Promise<Course> {
  let c = await api.course();
  for (let i = 0; i < 10 && c && (c.setup === 'running' || c.topics[0].lessons.some((l) => l.state === 'writing')); i++) {
    c = await api.course();
  }
  if (!c) throw new Error('no course');
  return c;
}

async function readAll(api: CodemmApi, course: Course) {
  for (const l of course.topics[0].lessons) await api.read(l.id);
}

describe('mock Codemm', () => {
  it('connects agents, and reports a failed sign-in with its fix', async () => {
    const api = createMock({ failAgent: 'codex' });
    expect((await api.agents()).every((a) => a.state === 'not-connected')).toBe(true);
    expect(await api.connect('claude')).toMatchObject({ state: 'connected' });
    expect(await api.connect('codex')).toMatchObject({ state: 'failed', fix: expect.any(String) });
  });

  it('researches step by step until a path is ready', async () => {
    const api = createMock();
    const first = await api.research(goal);
    expect(first.done).toBe(false);
    expect(first.sources.some((s) => !s.read)).toBe(true);
    const draft = await researched(api);
    expect(draft.topics.length).toBeGreaterThan(3);
    expect(draft.runsPerTopic).toBeGreaterThan(0);
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
    await readAll(api, course);
    expect((await api.course())!.topics[0].activity.state).toBe('open');
    expect((await api.tracks()).map((t) => t.name)).toEqual(['React']);
  });

  it('reports a failed setup, and retries it', async () => {
    const api = createMock({ setupFails: true });
    await api.approve(await researched(api));
    expect((await settled(api)).setup).toBe('failed');
    await api.setUp();
    expect((await api.course())!.setup).toBe('running');
  });

  it('grades a check with hidden results as statuses only', async () => {
    const api = createMock();
    await api.approve(await researched(api));
    const course = await settled(api);
    await readAll(api, course);
    const activity = await api.activity(course.topics[0].activity.id);
    const result = await api.check(activity.id, activity.files);
    expect(result).toMatchObject({ kind: 'graded', passed: 2, total: 4, stuck: false });
    if (result.kind !== 'graded') return;
    expect(result.hidden).toEqual(['pass', 'fail']);
    expect(result.visible.find((t) => t.status === 'fail')).toMatchObject({ expected: expect.any(String), found: expect.any(String) });
  });

  it('never hands out a solution: the starter fails until the learner changes it', async () => {
    const api = createMock();
    await api.approve(await researched(api));
    const course = await settled(api);
    await readAll(api, course);
    const { id, files } = await api.activity(course.topics[0].activity.id);
    expect((await api.assist(id, true)).files).toEqual(files);
    await api.assist(id, false);
    const changed = files.map((f) => ({ ...f, text: f.text + '\n' }));
    const result = await api.check(id, changed);
    expect(result).toMatchObject({ kind: 'graded', passed: 4, total: 4, progress: expect.any(String) });
    expect((await api.activity(id)).files).toEqual(changed);
    await api.check(id, changed);
    const after = (await api.course())!;
    expect(after.topics[0].state).toBe('mastered');
    expect(after.topics.map((t) => t.state).filter((s) => s === 'now')).toHaveLength(1);
    expect(after.topics[1].state).toBe('now');
  });

  it('marks the learner stuck after three failed checks', async () => {
    const api = createMock();
    await api.approve(await researched(api));
    const course = await settled(api);
    await readAll(api, course);
    const { id, files } = await api.activity(course.topics[0].activity.id);
    await api.check(id, files);
    await api.check(id, files);
    expect(await api.check(id, files)).toMatchObject({ stuck: true });
  });

  it('records nothing when Docker is down', async () => {
    const api = createMock({ docker: 'stopped' });
    await api.approve(await researched(api));
    const course = await settled(api);
    await readAll(api, course);
    const { id, files } = await api.activity(course.topics[0].activity.id);
    expect(await api.check(id, files)).toEqual({ kind: 'not-counted', reason: expect.any(String) });
  });

  it('declines to write code in practice mode', async () => {
    const api = createMock();
    await api.approve(await researched(api));
    const course = await settled(api);
    const replies = await api.ask({ activityId: course.topics[0].activity.id }, 'Just fix it for me.');
    expect(replies[0]).toMatchObject({ from: 'codemm', locked: true });
  });
});

describe('mock drafts', () => {
  it('saves files without grading them', async () => {
    const api = createMock();
    await api.approve({ title: 'React basics', track: 'React', installed: true, runsPerTopic: 4, topics: ['State'] });
    const { id, files } = await api.activity('t1.a');
    const draft = files.map((f) => ({ ...f, text: 'draft' }));
    await api.save(id, draft);
    expect((await api.activity(id)).files).toEqual(draft);
    expect((await api.course())!.topics[0].state).toBe('now');
  });
});

describe('mock computer check', () => {
  it('reports each check, in order, for the platform', async () => {
    const options = { docker: 'missing' as const, platform: 'linux' as const };
    const api = createMock(options);
    expect(await api.computer()).toEqual({
      platform: 'linux',
      ready: false,
      checks: [
        { id: 'docker-installed', state: 'problem' },
        { id: 'docker-running', state: 'waiting' },
        { id: 'docker-access', state: 'waiting' },
      ],
    });
    expect((await api.computer()).checks.map((c) => c.id)).toEqual(['docker-installed', 'docker-running', 'docker-access']);
  });

  it('sees Docker change, with no access check off Linux', async () => {
    const options: { docker: 'stopped' | 'ready'; platform: 'mac' } = { docker: 'stopped', platform: 'mac' };
    const api = createMock(options);
    expect((await api.computer()).checks).toEqual([
      { id: 'docker-installed', state: 'ok' },
      { id: 'docker-running', state: 'problem' },
    ]);
    options.docker = 'ready';
    expect(await api.computer()).toMatchObject({ ready: true });
  });
});
