// @vitest-environment node
import { describe, expect, it } from 'vitest';
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

  it('needs a course on screen', async () => {
    const t = live({}, { saveFile: async () => true });
    await expect(t.api.savePracticeTime({ time: '19:00', repeat: 'daily' })).rejects.toThrow('No course yet.');
  });
});
