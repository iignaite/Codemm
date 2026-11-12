// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { practiceCalendar } from './calendar';

// 12 Nov 2026, 10:00 local time.
const morning = new Date(2026, 10, 12, 10, 0);
const lines = (ics: string) => ics.split('\r\n');

describe('practice time calendar file (§4.15)', () => {
  it('is one repeating event at the chosen local time, starting today when the time is still ahead', () => {
    const ics = practiceCalendar({ time: '19:00', repeat: 'daily', course: 'React', now: morning, uid: 'abc' });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
    // Unfolded, as a calendar reads it.
    expect(ics.replace(/\r\n /g, '').split('\r\n')).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Codemm//Practice time//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:abc@codemm',
      `DTSTAMP:${utcStamp(morning)}`,
      'DTSTART:20261112T190000',
      'DURATION:PT30M',
      'RRULE:FREQ=DAILY',
      'SUMMARY:Practice with Codemm',
      'DESCRIPTION:Course: React. Open Codemm. A due review comes first\\, then your next topic.',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Practice with Codemm',
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('starts tomorrow when the time has passed today, and repeats on weekdays only', () => {
    const evening = new Date(2026, 10, 12, 21, 30);
    const ics = practiceCalendar({ time: '07:05', repeat: 'weekdays', course: 'React', now: evening, uid: 'abc' });
    expect(lines(ics)).toContain('DTSTART:20261113T070500');
    expect(lines(ics)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('starts tomorrow when the time is exactly now', () => {
    const ics = practiceCalendar({ time: '10:00', repeat: 'daily', course: 'React', now: morning, uid: 'abc' });
    expect(lines(ics)).toContain('DTSTART:20261113T100000');
  });

  it('crosses a month end', () => {
    const ics = practiceCalendar({ time: '06:00', repeat: 'daily', course: 'React', now: new Date(2026, 10, 30, 8, 0), uid: 'abc' });
    expect(lines(ics)).toContain('DTSTART:20261201T060000');
  });

  it("escapes the course's name and folds long lines at 75 octets, counting multibyte characters", () => {
    const course = 'C; pointers, arrays\\strings\nand a café ☕ course with a long name that needs folding';
    const ics = practiceCalendar({ time: '19:00', repeat: 'daily', course, now: morning, uid: 'abc' });
    const all = lines(ics);
    for (const line of all) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const start = all.findIndex((l) => l.startsWith('DESCRIPTION:Course'));
    let unfolded = all[start];
    for (let i = start + 1; all[i].startsWith(' '); i++) unfolded += all[i].slice(1);
    expect(unfolded).toBe('DESCRIPTION:Course: C\\; pointers\\, arrays\\\\strings\\nand a café ☕ course with a long name that needs folding. Open Codemm. A due review comes first\\, then your next topic.');
  });
});

/** A time in UTC as DTSTAMP writes it: YYYYMMDDTHHMMSSZ. */
function utcStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
