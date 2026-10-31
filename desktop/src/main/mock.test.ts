import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { CHANGED, NO_AGENT, PLAN_LIMIT, REBUILD, SIGNED_OUT, type CodemmApi, type CourseView, type JobProgress } from '../shared/api';
import { isSafeLink } from './links';
import { AGENT_INFO } from './connect';
import { createMock, scenario, SCENARIOS, type MockOptions } from './mock';

const goal = { topic: 'React', known: 'Python', depth: 'standard' as const, practice: 'code' as const };

async function roadmapped(options?: MockOptions, practice: 'code' | 'quiz' = 'code') {
  const api = createMock(options);
  await api.connect('claude');
  let r = await api.research({ ...goal, practice });
  while (r.state === 'running') r = await api.research({ ...goal, practice });
  return { api, roadmap: r.roadmap! };
}

describe('mock naming', () => {
  it('reports review progress after research and before returning the roadmap', async () => {
    const api = createMock();
    await api.connect('claude');
    const heard: JobProgress[] = [];
    api.onJobProgress((p) => heard.push(p));
    let result = await api.research(goal);
    while (result.state === 'running') result = await api.research(goal);
    expect(result.state).toBe('done');
    expect(heard.findIndex((p) => p.kind === 'review')).toBeGreaterThan(heard.findIndex((p) => p.kind === 'research' && p.ended));
    expect(heard.filter((p) => p.kind === 'review').map((p) => p.stage)).toEqual([0, 1, 2, 2]);
    expect(heard.at(-1)).toMatchObject({ kind: 'review', ended: true });
  });

  it('names a researched course as the live app would: a title, not the punctuation typed', async () => {
    const api = createMock();
    await api.connect('claude');
    const typed = { ...goal, topic: 'springboot?' };
    let r = await api.research(typed);
    while (r.state === 'running') r = await api.research(typed);
    expect(r.roadmap).toMatchObject({ title: 'Springboot', goal: 'springboot?' });
  });
});

async function settled(api: CodemmApi, until: (c: CourseView) => boolean): Promise<CourseView> {
  for (let i = 0; i < 10; i++) {
    const c = (await api.course())!;
    if (until(c)) return c;
  }
  throw new Error('course never settled');
}

/** A course whose track is set up and whose first topic's lessons are read. */
async function practising(options?: MockOptions) {
  const { api, roadmap } = await roadmapped(options);
  await api.approve(roadmap.concepts);
  const consent = await settled(api, (c) => c.setup === 'consent');
  await api.install(consent.proposal!.digest);
  const course = await settled(api, (c) => c.setup === 'ready' && c.topics[0].lessons.every((l) => l.state !== 'writing'));
  for (const l of course.topics[0].lessons) await api.markRead(l.id);
  return { api, activity: await api.activity(course.topics[0].id) };
}

describe('mock: quiz', () => {
  async function quiz() {
    const { api, roadmap } = await roadmapped({ docker: 'missing', imageMissing: true, style: 'io' }, 'quiz');
    await api.approve(roadmap.concepts);
    return { api, roadmap, activity: await api.activity(roadmap.concepts[0].id) };
  }

  it('needs no setup or track and gives every concept questions without a key', async () => {
    const { api, roadmap } = await quiz();
    expect(await api.course()).toMatchObject({ setup: 'ready', activities: true });
    expect((await api.course())!.proposal).toBeUndefined();
    expect(await api.tracks()).toEqual([]);
    for (const concept of roadmap.concepts) {
      const activity = await api.activity(concept.id);
      expect(activity.style).toBe('quiz');
      if (activity.style !== 'quiz') throw new Error('Expected a quiz');
      expect(activity.statement).not.toBe('');
      expect(activity.questions).toHaveLength(5);
      for (const question of activity.questions) {
        expect(Object.keys(question)).toEqual(['text', 'choices']);
        expect(question.choices).toHaveLength(3);
        for (const choice of question.choices) expect(Object.keys(choice)).toEqual(['text']);
      }
      expect(activity.visibleTests).toEqual([]);
      expect(activity.run).toBeUndefined();
      expect(activity.files.map((f) => f.path)).toEqual(['answers.yaml']);
      expect(parse(activity.files[0].text)).toEqual({ 1: null, 2: null, 3: null, 4: null, 5: null });
      expect((await api.lesson(`${concept.id}-1`)).examples).toEqual([]);
    }
    await api.setActivities(false);
    await api.setActivities(true);
    expect(await api.course()).toMatchObject({ setup: 'ready' });
  });

  it('requires all answers, grades only picked choices and records only the first full check', async () => {
    const { api, activity } = await quiz();
    let digest = activity.files[0].digest;
    const save = async (answers: Record<number, number | null>) => {
      digest = await api.saveFile(activity.id, 'answers.yaml', stringify(answers), digest);
    };
    await expect(api.check(activity.id)).rejects.toThrow('Answer every question, then check.');
    await save({ 1: 1, 2: 1, 3: 1, 4: 1 });
    await expect(api.check(activity.id)).rejects.toThrow('Answer every question, then check.');
    await save({ 1: 2, 2: 1, 3: 1, 4: 1, 5: 1 });
    const result = await api.check(activity.id);
    expect(result).toMatchObject({ kind: 'graded', passed: 4, total: 5, recorded: true, mastered: false });
    if (result.kind !== 'graded') throw new Error('Expected a grade');
    expect(result.tests).toEqual([
      { hidden: false, name: '1', status: 'fail', message: 'Changing a local variable does not update the screen.' },
      ...['2', '3', '4', '5'].map((name) => ({ hidden: false, name, status: 'pass' })),
    ]);
    const before = await api.course();
    await save({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    expect(await api.check(activity.id)).toMatchObject({ passed: 5, recorded: false, mastered: false });
    expect(await api.course()).toEqual(before);
  });

  it('masters a topic on a first passing check and refuses Try it and Run', async () => {
    const { api, activity } = await quiz();
    await expect(api.tryIt(activity.id)).rejects.toThrow("A quiz has no practice run. Check it when you're ready.");
    await expect(api.runProgram(activity.id, 'quiz-run')).rejects.toThrow("Run isn't available");
    await api.saveFile(activity.id, 'answers.yaml', stringify({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }), activity.files[0].digest);
    expect(await api.check(activity.id)).toMatchObject({ passed: 5, total: 5, recorded: true, mastered: true });
    expect((await api.course())!.topics[0]).toMatchObject({ mastery: 1, activity: 'passed' });
    expect(await api.check(activity.id)).toMatchObject({ recorded: false, mastered: true });
  });
});

describe('mock: installing an agent', () => {
  it('installs a missing agent step by step, then checks its sign-in; signing in connects it on the next look', async () => {
    const api = createMock({ ...scenario('no-agent'), platform: 'mac' });
    const codex = async () => (await api.agents()).find((a) => a.id === 'codex')!;
    expect(await codex()).toMatchObject({ state: 'missing', canInstall: true });
    expect((await api.agents()).find((a) => a.id === 'cursor')!.canInstall).toBe(true);
    await api.installAgent('codex');
    const phases: string[] = [];
    for (let a = await codex(); a.install?.phase !== 'done' && a.install?.phase !== 'failed'; a = await codex()) phases.push(a.install!.phase);
    expect(phases).toContain('downloading');
    expect(await codex()).toMatchObject({ state: 'signed-out', install: { phase: 'done' } });
    await api.signIn('codex');
    expect(await codex()).toMatchObject({ state: 'connected' });
  });

  it('says why an install stopped, and can try again', async () => {
    const api = createMock({ ...scenario('agent-install-offline'), platform: 'mac' });
    await api.installAgent('claude');
    let claude = (await api.agents()).find((a) => a.id === 'claude')!;
    while (claude.install?.phase !== 'failed') claude = (await api.agents()).find((a) => a.id === 'claude')!;
    expect(claude).toMatchObject({ state: 'missing', install: { phase: 'failed', problem: 'offline' } });
  });

  it('cannot install on Linux', async () => {
    const api = createMock({ ...scenario('no-agent'), platform: 'linux' });
    expect((await api.agents()).every((a) => !a.canInstall)).toBe(true);
  });
});

describe('mock: agents', () => {
  it('describes each agent exactly as the connect screen\'s connector does', async () => {
    const agents = await createMock().agents();
    expect(agents.map(({ id, name, installUrl, experimental }) => ({ id, name, installUrl, experimental }))).toEqual(
      Object.entries(AGENT_INFO).map(([id, info]) => ({ id, ...info })),
    );
  });
});

describe('mock: roadmap and setup', () => {
  it('keeps the approved course while a new roadmap is a draft, with edits saved as they happen', async () => {
    const { api } = await practising();
    expect(await api.draft()).toBeNull();
    let r = await api.research({ ...goal, topic: 'Vue' });
    while (r.state === 'running') r = await api.research({ ...goal, topic: 'Vue' });
    expect((await api.course())!.goal).toBe('React');
    const edited = [...r.roadmap!.concepts.slice(0, -2), ...r.roadmap!.concepts.slice(-2).reverse()];
    await api.saveDraft(edited);
    expect((await api.draft())!).toMatchObject({ goal: 'Vue', concepts: edited });
    await api.approve((await api.draft())!.concepts);
    expect((await api.course())!.goal).toBe('Vue');
    expect(await api.draft()).toBeNull();
  });

  it('researches until a roadmap with prerequisites is ready', async () => {
    const { roadmap } = await roadmapped();
    expect(roadmap.concepts.length).toBeGreaterThan(3);
    expect(roadmap.concepts[1].requires).toEqual([roadmap.concepts[0].id]);
    expect(roadmap.installed).toBe(false);
  });

  it('proposes setup, waits for consent, and builds exactly the proposal shown', async () => {
    const { api, roadmap } = await roadmapped();
    await api.approve(roadmap.concepts);
    expect((await api.course())!.setup).toBe('consent');
    const consent = (await api.course())!;
    expect(consent.proposal!.files.map((f) => f.path)).toEqual(['Dockerfile', 'track.yaml']);
    await expect(api.install('0'.repeat(64))).rejects.toThrow('The setup changed');
    await api.install(consent.proposal!.digest);
    expect((await api.course())!.setup).toBe('ready');
    expect((await api.tracks()).map((t) => t.name)).toEqual(['React']);
  });

  it('opens the activity once the lessons are read', async () => {
    const { api, activity } = await practising();
    expect(activity.files[0].text).toContain('/* your code */');
    expect((await api.course())!.topics[0].activity).toBe('open');
  });
});

describe('mock: practice', () => {
  it('grades hidden tests as an index and a status only, and records nothing for the unedited starter', async () => {
    const { api, activity } = await practising();
    const result = await api.check(activity.id);
    expect(result).toMatchObject({ kind: 'graded', passed: 2, total: 4, recorded: false });
    if (result.kind !== 'graded') return;
    expect(result.tests.filter((t) => t.hidden)).toEqual([{ hidden: true, index: 1, status: 'pass' }, { hidden: true, index: 2, status: 'fail' }]);
  });

  it('saves files by digest and refuses a stale one', async () => {
    const { api, activity } = await practising();
    const [file] = activity.files;
    const digest = await api.saveFile(activity.id, file.path, 'draft', file.digest);
    expect(digest).not.toBe(file.digest);
    await expect(api.saveFile(activity.id, file.path, 'again', file.digest)).rejects.toThrow(CHANGED);
    expect((await api.activity(activity.concept)).files[0].text).toBe('draft');
  });

  it('never hands out a solution: only the learner\'s edit passes', async () => {
    const { api, activity } = await practising();
    expect(await api.tryIt(activity.id)).toMatchObject({ kind: 'ran', passed: 1, total: 2 });
    const [file] = activity.files;
    await api.saveFile(activity.id, file.path, file.text.replace('/* your code */', 'count + 1'), file.digest);
    expect(await api.check(activity.id)).toMatchObject({ kind: 'graded', passed: 4, total: 4, recorded: true, mastered: true });
    const after = (await api.course())!;
    expect(after.topics[0].state).toBe('mastered');
    expect(after.topics.filter((t) => t.state === 'now')).toHaveLength(1);
  });

  it('is stuck after three recorded failures, and an easier topic gives a fresh start', async () => {
    const { api, activity } = await practising();
    await api.saveFile(activity.id, activity.files[0].path, '/* your code */ wrong', activity.files[0].digest);
    await api.check(activity.id);
    await api.check(activity.id);
    expect(await api.check(activity.id)).toMatchObject({ stuck: true, later: true });
    await api.easier(activity.concept);
    const course = (await api.course())!;
    expect(course.topics[0]).toMatchObject({ title: 'JavaScript basics: first steps', state: 'now' });
    expect(course.topics[1]).toMatchObject({ id: activity.concept, stuck: false });
  });

  it('skips honestly: the topic is deferred, not mastered', async () => {
    const { api, roadmap } = await roadmapped();
    await api.approve(roadmap.concepts);
    await api.skip(roadmap.concepts[0].id);
    const course = (await api.course())!;
    expect(course.topics[0]).toMatchObject({ state: 'later', mastery: 0 });
    // JSX requires it, and a topic left for later unlocks the ones after it (core §7).
    expect(course.topics.find((t) => t.state === 'now')!.id).toBe('jsx');
  });

  it('keeps every deferral until that topic is checked again', async () => {
    const { api, roadmap } = await roadmapped();
    await api.approve(roadmap.concepts);
    await api.skip('javascript-basics');
    await api.skip('jsx');
    expect((await api.course())!.topics.find((t) => t.state === 'now')!.id).toBe('components');
  });

  it('declines to write code in practice mode', async () => {
    const { api, activity } = await practising();
    const [reply] = await api.ask({ activityId: activity.id }, 'Just fix it for me.');
    expect(reply.text).toContain('In practice mode, you write the code.');
  });
});

describe('mock: agents', () => {
  it('offers bench-tested models with the recommended one chosen, and marks Cursor experimental', async () => {
    const api = createMock();
    const agents = await api.agents();
    expect(agents.find((a) => a.id === 'codex')).toMatchObject({ state: 'not-connected', model: 'gpt-6-luna', experimental: false, untested: false });
    expect(agents.find((a) => a.id === 'cursor')).toMatchObject({ experimental: true, models: [{ id: 'auto', label: 'Auto', recommended: true }], model: 'auto' });
    expect(await api.chooseModel('claude', 'opus')).toMatchObject({ id: 'claude', model: 'opus' });
    await expect(api.chooseModel('claude', 'gpt-6-luna')).rejects.toThrow();
    expect((await createMock(scenario('untested-version')).agents())[0].untested).toBe(true);
  });

  it('reports agents that are not installed, with an install page', async () => {
    const api = createMock(scenario('no-agent'));
    const agents = await api.agents();
    expect(agents.map((a) => a.state)).toEqual(['missing', 'missing', 'missing']);
    for (const a of agents) expect(isSafeLink(a.installUrl)).toBe(true);
    expect(await api.connect('codex')).toMatchObject({ state: 'missing' });
    await expect(api.research(goal)).rejects.toThrow(NO_AGENT);
  });

  it('sees an agent installed, switched to or removed while the app runs, as main\'s lookup does', async () => {
    const options = scenario('no-agent');
    const api = createMock(options);
    const states = async () => (await api.agents()).map((a) => a.state);
    expect(await states()).toEqual(['missing', 'missing', 'missing']);
    options.agents = { cursor: 'missing' };
    expect(await states()).toEqual(['not-connected', 'not-connected', 'missing']);
    await api.connect('claude');
    await api.connect('codex');
    expect(await states()).toEqual(['not-connected', 'connected', 'missing']);
    options.agents = { codex: 'missing', cursor: 'missing' };
    expect(await states()).toEqual(['not-connected', 'missing', 'missing']);
    await expect(api.research(goal)).rejects.toThrow(NO_AGENT);
  });

  it('agent-found-later: Claude Code shows up on the look after the first, as if installed in a terminal', async () => {
    const api = createMock(scenario('agent-found-later'));
    const claude = async () => (await api.agents()).find((a) => a.id === 'claude')!.state;
    expect(await claude()).toBe('missing');
    expect(await claude()).toBe('not-connected');
  });

  it('reports an agent that is installed but signed out', async () => {
    expect(await createMock(scenario('signed-out')).connect('codex')).toMatchObject({ state: 'signed-out' });
  });

  it('fails agent jobs when sign-in expires mid-session, until the learner signs in again', async () => {
    const { api, roadmap } = await roadmapped(scenario('sign-in-expires'));
    await api.approve(roadmap.concepts);
    await expect(api.ask({ lessonId: `${roadmap.concepts[0].id}-1` }, 'Why?')).rejects.toThrow(SIGNED_OUT);
    expect((await api.agents())[0].state).toBe('signed-out');
    expect(await api.connect('claude')).toMatchObject({ state: 'connected' });
    await expect(api.ask({ lessonId: `${roadmap.concepts[0].id}-1` }, 'Why?')).resolves.toHaveLength(1);
  });

  it('fails agent jobs at the plan limit', async () => {
    const { api, roadmap } = await roadmapped(scenario('plan-limit'));
    await api.approve(roadmap.concepts);
    await expect(api.easier(roadmap.concepts[0].id)).rejects.toThrow(PLAN_LIMIT);
  });
});

describe('mock: environment', () => {
  it('runs the computer checks in order, and only the first failing one is a problem', async () => {
    expect(await createMock({ docker: 'missing', platform: 'windows' }).computer()).toEqual({
      platform: 'windows',
      ready: false,
      canInstall: true,
      checks: [
        { id: 'docker-installed', state: 'problem' },
        { id: 'docker-running', state: 'waiting' },
        { id: 'sandbox', state: 'waiting' },
      ],
    });
    expect((await createMock(scenario('docker-starting')).computer()).checks[1]).toEqual({ id: 'docker-running', state: 'problem', detail: 'starting' });
    expect((await createMock(scenario('windows-containers')).computer()).checks[1]).toEqual({ id: 'docker-running', state: 'problem', detail: 'windows-containers' });
  });

  it('installs Docker step by step, then it starts and the computer is ready', async () => {
    const api = createMock({ docker: 'missing', platform: 'mac' });
    await api.installDocker();
    const seen: string[] = [];
    for (let i = 0; i < 10 && seen.at(-1) !== 'ready'; i++) {
      const c = await api.computer();
      const now = c.ready ? 'ready' : `${c.install?.phase ?? '-'}:${c.checks.find((x) => x.state === 'problem')?.id ?? ''}`;
      if (seen.at(-1) !== now) seen.push(now);
    }
    expect(seen).toEqual(['downloading:docker-installed', 'checking:docker-installed', 'installing:docker-installed', 'starting:docker-running', 'ready']);
    expect((await createMock({ docker: 'missing', platform: 'linux' }).computer()).canInstall).toBeUndefined();
  });

  it('opens a stopped Docker, which starts, then runs', async () => {
    const api = createMock({ docker: 'stopped', platform: 'mac' });
    expect((await api.computer()).checks[1]).toEqual({ id: 'docker-running', state: 'problem' });
    await api.openDocker();
    expect((await api.computer()).checks[1]).toEqual({ id: 'docker-running', state: 'problem', detail: 'starting' });
    expect((await api.computer()).ready).toBe(true);
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
    expect(await api.check(activity.id)).toMatchObject({ kind: 'graded' });
    const digest = await api.saveFile(activity.id, activity.files[0].path, 'mine', activity.files[0].digest);
    expect(await api.check(activity.id)).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
    expect(await api.tryIt(activity.id)).toMatchObject({ kind: 'not-counted' });
    expect((await api.activity(activity.concept)).files[0]).toMatchObject({ text: 'mine', digest });
  });

  it('says a check needs a rebuild when the track image is missing, and records nothing', async () => {
    const { api, activity } = await practising(scenario('image-missing'));
    expect(await api.check(activity.id)).toEqual({ kind: 'not-counted', reason: REBUILD });
    expect(await api.tryIt(activity.id)).toEqual({ kind: 'not-counted', reason: REBUILD });
  });

  it('fails setup offline or low on disk, records nothing, and retries the same proposal', async () => {
    for (const [name, problem] of [['offline-setup', 'offline'], ['low-disk', 'disk']] as const) {
      const { api, roadmap } = await roadmapped(scenario(name));
      await api.approve(roadmap.concepts);
      const { proposal } = await settled(api, (c) => c.setup === 'consent');
      await api.install(proposal!.digest);
      expect(await settled(api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: problem });
      expect(await api.tracks()).toEqual([]);
      await api.install(proposal!.digest);
      expect(await settled(api, (c) => c.setup !== 'installing')).toMatchObject({ setup: 'ready' });
    }
  });

  it('asks again with a new proposal after the gates fail', async () => {
    const { api, roadmap } = await roadmapped(scenario('setup-gates'));
    await api.approve(roadmap.concepts);
    const { proposal } = await settled(api, (c) => c.setup === 'consent');
    await api.install(proposal!.digest);
    expect(await settled(api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'gates' });
    await api.retrySetup();
    expect(await settled(api, (c) => c.setup === 'consent')).toMatchObject({ proposal: { retry: true } });
  });

  it('a relaunch shows the agent connected before', async () => {
    expect((await createMock(scenario('relaunch')).agents()).find((a) => a.id === 'claude')!.state).toBe('connected');
  });

  it('names every scenario, and rejects unknown ones', () => {
    expect(Object.keys(SCENARIOS)).toHaveLength(33);
    expect(scenario(undefined)).toEqual({});
    expect(() => scenario('nope')).toThrow('Unknown mock scenario');
  });
});

describe('mock: job progress (§4.11)', () => {
  it('reports each job kind through its stages, then its end; without slow, jobs finish at once', async () => {
    const api = createMock();
    const heard: JobProgress[] = [];
    api.onJobProgress((p) => heard.push(p));
    await api.connect('claude');
    let r = await api.research({ topic: 'React', known: '', depth: 'standard', practice: 'code' });
    while (r.state === 'running') r = await api.research({ topic: 'React', known: '', depth: 'standard', practice: 'code' });
    await api.approve(r.roadmap!.concepts);
    await api.course();
    expect(new Set(heard.map((p) => p.kind))).toEqual(new Set(['research', 'review', 'setup', 'lesson']));
    const lesson = heard.filter((p) => p.kind === 'lesson');
    expect(lesson.map((p) => [p.stage, p.ended ?? false])).toEqual([[0, false], [1, false], [2, false], [2, true]]);
    expect(await api.jobProgress()).toEqual([]);
  });

  it('slow: a job holds each stage over several reads, and jobProgress lists it meanwhile', async () => {
    const api = createMock({ slow: 2 });
    await api.connect('claude');
    let r = await api.research({ topic: 'React', known: '', depth: 'standard', practice: 'code' });
    while (r.state === 'running') r = await api.research({ topic: 'React', known: '', depth: 'standard', practice: 'code' });
    await api.approve(r.roadmap!.concepts);
    await api.course();
    expect((await api.jobProgress()).map((p) => [p.kind, p.stage])).toEqual([['setup', 0], ['lesson', 0]]);
    for (let i = 0; i < 6; i++) await api.course();
    expect((await api.course())!.setup).toBe('consent');
  });

  it('a rebuild is a job of its own, named for its track: at once, or held when slow', async () => {
    const { api } = await practising();
    const heard: JobProgress[] = [];
    api.onJobProgress((p) => heard.push(p));
    await api.rebuild((await api.tracks())[0].ref);
    expect(heard.map((p) => [p.kind, p.track, p.ended ?? false])).toEqual([['rebuild', 'React', false], ['rebuild', 'React', true]]);
    expect(await api.jobProgress()).toEqual([]);

    const options: MockOptions = {};
    const slow = await practising(options);
    options.slow = 1;
    const rebuilding = slow.api.rebuild((await slow.api.tracks())[0].ref);
    expect(await slow.api.jobProgress()).toEqual([expect.objectContaining({ kind: 'rebuild', track: 'React' })]);
    await rebuilding;
    expect(await slow.api.jobProgress()).toEqual([]);
  });

  it('quiet: every job has been quiet for over 90 seconds', async () => {
    const api = createMock({ quiet: true });
    const heard: JobProgress[] = [];
    api.onJobProgress((p) => heard.push(p));
    await api.connect('claude');
    await api.research({ topic: 'React', known: '', depth: 'standard', practice: 'code' });
    expect(heard[0]!.idleMs).toBeGreaterThan(90_000);
  });
});

describe('mock: Run', () => {
  it('runs an io activity\'s program with typed input and says when its time is up', async () => {
    const { api, activity } = await practising({ style: 'io', runLimitMs: 50 });
    expect(activity.run).toBe('python3 main.py');
    const heard: unknown[] = [];
    api.onRunOutput((o) => heard.push(o));
    const ran = api.runProgram(activity.id, 'run-1');
    expect(await api.sendRunInput('run-1', 'Ada\n')).toBe(true);
    expect(await ran).toMatchObject({ kind: 'ran', exit: 0, timedOut: false });
    expect(heard).toEqual([
      { run: 'run-1', started: 'run', limitMs: 50 },
      { run: 'run-1', stream: 'stdout', text: "What's your name? " },
      { run: 'run-1', stream: 'stdout', text: 'Hello, Ada!\n' },
    ]);
    expect(await api.runProgram(activity.id, 'run-2')).toMatchObject({ kind: 'ran', timedOut: true });
    const stopped = api.runProgram(activity.id, 'run-3');
    await api.stopRun('run-3');
    expect(await stopped).toMatchObject({ kind: 'ran', stopped: true });
  });

  it('streams each visible io test\'s result in Try it and Check, and nothing about hidden ones', async () => {
    const { api, activity } = await practising({ style: 'io' });
    const heard: unknown[] = [];
    api.onCheckProgress((p) => heard.push(p));
    await api.check(activity.id, 'run-1');
    expect(heard).toEqual([
      { run: 'run-1', phase: 'visible', done: 0, total: 2 },
      { run: 'run-1', phase: 'visible', done: 1, total: 2, test: { name: 'visible/01', status: 'fail', message: 'Output differs from the expected output.', actual: 'Hello, !\n' } },
      { run: 'run-1', phase: 'visible', done: 2, total: 2, test: { name: 'visible/02', status: 'fail', message: 'Output differs from the expected output.', actual: 'Hello, !\n' } },
      { run: 'run-1', phase: 'hidden', done: 0, total: 0 },
    ]);
  });

  it('has no Run for a unit activity', async () => {
    const { activity } = await practising();
    expect(activity.run).toBeUndefined();
  });
});
