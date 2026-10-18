// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CHANGED, REPAIR } from '../shared/api';
import { coreError, live, practising } from './testing/fakes';

describe('live CodemmApi: failures and damaged records (§5)', () => {
  it("classifies core's failures by their kind, whatever the wording, and plain text alone not at all", async () => {
    const t = live();
    const activity = await practising(t);
    const core = (message: string, kind?: string) => Object.assign(new Error(message), { name: 'CodemmError', ...(kind ? { kind } : {}) });
    const check = t.app.checkExercise;
    t.app.checkExercise = async () => { throw core('Some new wording', 'disk'); };
    expect(await t.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: 'Docker ran out of disk space.' });
    t.app.checkExercise = async () => { throw core('Reworded too', 'image-missing'); };
    expect(await t.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: expect.stringMatching(/rebuild/i) });
    // A write that ran out of space on this computer, before core could say so.
    t.app.checkExercise = async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
    expect(await t.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: 'Docker ran out of disk space.' });
    // Core's wording without its kind is not this computer's problem: it isn't hidden as "not counted".
    t.app.checkExercise = async () => { throw core("The container runtime isn't running."); };
    await expect(t.api.check(activity.id)).rejects.toThrow(/container runtime/);
    t.app.checkExercise = check;

    const save = t.app.writeLearnerFile;
    t.app.writeLearnerFile = async () => { throw core('Reload the file.', 'changed'); };
    await expect(t.api.saveFile(activity.id, 'main.c', 'x', activity.files[0].digest)).rejects.toThrow(CHANGED);
    t.app.writeLearnerFile = save;

    const progress = t.app.progress;
    t.app.progress = () => { throw core('A record needs fixing.', 'damaged'); };
    await expect(t.api.course()).rejects.toMatchObject({ message: `${REPAIR}\nA record needs fixing.` });
    t.app.progress = progress;
  });

  it("says Codemm's records need a repair, with core's guidance, when a record is damaged", async () => {
    const t = live();
    await practising(t);
    const guidance = "Codemm's record /h/courses/react/course.json is damaged. Restore it from a backup, or remove that track, course or exercise.";
    const damaged = coreError(guidance, 'damaged');
    t.app.progress = () => {
      throw damaged;
    };
    const failure = await t.api.course().catch((e: Error) => e);
    expect(failure).toMatchObject({ name: 'CodemmError', message: `${REPAIR}\n${guidance}` });
    t.app.progress = () => {
      throw coreError('The learning log /h/courses/react/events.jsonl has an invalid entry on line 3. Fix or remove that line, then retry.', 'damaged');
    };
    await expect(t.api.check('values-easy-1')).rejects.toThrow(/^codemm:repair\nThe learning log/);
  });

  it('a damaged course record asks for a repair instead of looking like no course (D14)', async () => {
    const t = live();
    await practising(t);
    t.app.getRoadmap = () => {
      throw coreError("Codemm's record /h/courses/react/course.json is damaged. Restore it from a backup, or remove that track, course or exercise.", 'damaged');
    };
    await expect(t.api.course()).rejects.toThrow(/^codemm:repair\nCodemm's record/);
    t.app.getRoadmap = () => {
      throw coreError('No course in this workspace yet. Ask your agent to plan a roadmap (save_roadmap).', 'no-course');
    };
    expect(await t.api.course()).toBeNull();
  });
});
