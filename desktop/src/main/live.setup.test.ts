// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { type JobProgress } from '../shared/api';
import { coreError, live, practising, researched, until } from './testing/fakes';

describe('live CodemmApi: setup consent and install (§4.1)', () => {
  it('proposes setup, builds only the proposal the learner saw, then writes lessons and an activity', async () => {
    const t = live();
    const activity = await practising(t);
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'setup', 'lesson', 'author']);
    expect(activity).toMatchObject({ id: 'values-easy-1', concept: 'values', title: 'Count up', statement: 'Print one.' });
    expect(JSON.stringify(activity)).not.toContain('/Users/me');
  });

  it('refuses to build a proposal the learner did not see', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.setup === 'consent');
    await expect(t.api.install('b'.repeat(64))).rejects.toThrow('The setup changed');
  });

  it('records nothing and retries the same proposal when setup fails offline or on low disk', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    const install = t.c.install;
    t.c.install = async () => {
      throw coreError("The track build couldn't reach the network (Could not resolve host: registry.npmjs.org).", 'offline');
    };
    await t.api.install(proposal!.digest);
    // The failed view keeps the approved proposal, so Try again builds the same files.
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'offline', proposal: { digest: proposal!.digest } });
    t.c.install = install;
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'ready')).toMatchObject({ setup: 'ready' });
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')).toHaveLength(1);
  });

  it('asks for a new proposal after the gates fail', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    t.c.install = async () => {
      throw new Error('Gate 3 failed: the image has no test runner');
    };
    await t.api.install(proposal!.digest);
    const again = await until(t.api, (c) => c.setup === 'consent');
    expect(again.proposal!.retry).toBe(true);
    expect(t.jobs.ran.filter((j) => j.kind === 'setup').at(-1)!.brief).toContain('no test runner');
  });

  it('a setup that fails on this computer keeps its proposal, by kind', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    t.c.install = async () => { throw Object.assign(new Error('Docker could not finish.'), { name: 'CodemmError', kind: 'offline' }); };
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'offline', proposal: { digest: proposal!.digest } });
  });

  it('starts no setup or lesson before the learner approves the roadmap', async () => {
    const t = live();
    await researched(t);
    expect(await t.api.course()).toBeNull();
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research']);
  });

  it('a Docker failure during setup keeps the proposal, and Docker stopping during a Check is not counted', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    const install = t.c.install;
    t.c.install = async () => {
      throw coreError("The container runtime isn't running. Start Docker Desktop, then retry.", 'docker');
    };
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'docker', proposal: { digest: proposal!.digest } });
    t.c.install = install;
    await t.api.install(proposal!.digest);
    await until(t.api, (c) => c.setup === 'ready');

    const s = live();
    const activity = await practising(s);
    s.app.checkExercise = async () => {
      throw coreError("The container runtime stopped during the run, so it wasn't counted. Start Docker Desktop.", 'docker');
    };
    expect(await s.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
  });

  it("shows a setup's install as Codemm's own stage, and another proposal as a retry", async () => {
    const t = live();
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const consent = await until(t.api, (c) => c.setup === 'consent');
    t.c.install = async () => {
      throw new Error('Gate 3 failed: the image has no test runner');
    };
    await t.api.install(consent.proposal!.digest);
    await until(t.api, (c) => c.setup === 'consent');
    const install = heard.find((p) => p.kind === 'setup' && p.stage === 1)!;
    expect(install).toMatchObject({ thinking: false });
    expect(heard.filter((p) => p.job === install.job).at(-1)!.ended).toBe(true);
    expect(heard.filter((p) => p.kind === 'setup' && p.stage === 0).at(-1)!.retry).toEqual({ attempt: 2, of: 3 });
  });

  it("shows a setup's build steps as counts, then its checks", async () => {
    const t = live();
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const consent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(consent.proposal!.digest);
    await vi.waitFor(() => expect(heard.some((p) => p.kind === 'setup' && p.stage === 2 && p.ended)).toBe(true));
    const install = heard.filter((p) => p.kind === 'setup' && p.job === heard.find((x) => x.stage === 1)!.job);
    expect(install.map((p) => [p.stage, p.part ?? null, p.ended ?? false])).toEqual([
      [1, null, false], [1, { done: 1, total: 2 }, false], [1, { done: 2, total: 2 }, false], [2, null, false], [2, null, true],
    ]);
  });

  it('a proposal the learner already acted on counts as the setup job\'s work, even after its gates failed', async () => {
    let acted: () => void = () => {};
    const actedOn = new Promise<void>((r) => (acted = r));
    const t = live({
      setup: async () => {
        t.c.proposals.push({ track: 'react@1', digest: 'a'.repeat(64), created: new Date().toISOString(), files: { Dockerfile: 'FROM x' } });
        // The learner approves while the agent is still ending its turn, and the gates reject it.
        await actedOn;
        await new Promise((r) => setTimeout(r, 5));
        return {};
      },
    });
    t.c.install = async () => {
      acted();
      throw new Error('Gate 2 failed: the reference solution fails its tests');
    };
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
    expect((await t.api.course())!.stalled).toBeUndefined();
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')[1].brief).toContain('reference solution fails');
  });

  it('after a gate failure, waits for the old proposal to go before asking for a new one', async () => {
    const t = live();
    const drop = t.app.dropProposal;
    // Deleting waits for the track lock.
    t.app.dropProposal = (ref) => new Promise((r) => setTimeout(() => r(drop(ref)), 30));
    t.c.install = async () => {
      throw new Error('Gate 2 failed: the reference solution fails its tests');
    };
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
  });
});

describe('Docker Desktop for the learner (§6.1)', () => {
  it('installs and opens Docker through the installer, and logs the install', async () => {
    const calls: string[] = [];
    const t = live({}, { docker: { install: () => void calls.push('install'), open: async () => void calls.push('open') } });
    await t.api.installDocker();
    await t.api.openDocker();
    expect(calls).toEqual(['install', 'open']);
    expect(readFileSync(t.logFile, 'utf8')).toMatch(/ docker-install\n/);
  });
});
