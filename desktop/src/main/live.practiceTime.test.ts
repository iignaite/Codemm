// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { desktopState } from './state';
import { live, practising } from './testing/fakes';

describe('live CodemmApi: practice time (§4.15)', () => {
  it("saves the course on screen's practice time where the learner chooses, and nothing when they cancel", async () => {
    const saved: { name: string; text: string }[] = [];
    let answer = true;
    const t = live({}, { saveFile: async (name, text) => (saved.push({ name, text }), answer) });
    await practising(t);
    expect(await t.api.savePracticeTime({ time: '07:30', repeat: 'weekdays' })).toEqual({ saved: true });
    expect(saved.map((s) => s.name)).toEqual(['Codemm practice.ics']);
    const text = saved[0].text.replace(/\r\n /g, '');
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(text).toMatch(/DTSTART:\d{8}T073000\r\n/);
    expect(text).toContain('DESCRIPTION:Course: React.');
    answer = false;
    expect(await t.api.savePracticeTime({ time: '19:00', repeat: 'daily' })).toEqual({ saved: false });
  });

  it("names the course as the learner renamed it, keeps one event per course across saves, and says when the file couldn't be written", async () => {
    const saved: string[] = [];
    let fails = false;
    const t = live({}, { saveFile: async (_name, text) => {
      if (fails) throw new Error('EACCES: permission denied, open /Users/x/Documents/Codemm practice.ics');
      saved.push(text.replace(/\r\n /g, ''));
      return true;
    } });
    await practising(t);
    const course = t.c.active!;
    desktopState(t.dir).update((s) => ({ ...s, names: { ...s.names, [course]: 'My React' } }));
    await t.api.savePracticeTime({ time: '19:00', repeat: 'daily' });
    await t.api.savePracticeTime({ time: '07:00', repeat: 'daily' });
    expect(saved[0]).toContain('DESCRIPTION:Course: My React.');
    const uid = (text: string) => /\r\nUID:([^\r]+)\r\n/.exec(text)?.[1];
    expect(uid(saved[0])).toBe(`practice-${course}@codemm`);
    expect(uid(saved[1])).toBe(uid(saved[0]));
    fails = true;
    await expect(t.api.savePracticeTime({ time: '19:00', repeat: 'daily' })).rejects.toThrow("Codemm couldn't save the file. Choose another folder and try again.");
  });

  it('needs a course on screen', async () => {
    const t = live({}, { saveFile: async () => true });
    await expect(t.api.savePracticeTime({ time: '19:00', repeat: 'daily' })).rejects.toThrow('No course yet.');
  });
});
