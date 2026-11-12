// The practice time's calendar file (DESIGN §4.15): one repeating event in standard iCalendar (RFC 5545), which every
// calendar app imports. Codemm has no server, so the learner's own calendar brings them back.

import type { PracticeTime } from '../shared/api';

const SUMMARY = 'Practice with Codemm';
const RRULE = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' };

/** The calendar file for a practice time: today at that time if it is still ahead, otherwise tomorrow. */
export function practiceCalendar({ time, repeat, course, now, uid }: PracticeTime & { course: string; now: Date; uid: string }): string {
  const [hour, minute] = time.split(':').map(Number);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (start <= now) start.setDate(start.getDate() + 1);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Codemm//Practice time//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@codemm`,
    `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    // Floating local time: the event follows the learner's time zone.
    `DTSTART:${local(start)}`,
    'DURATION:PT30M',
    `RRULE:${RRULE[repeat]}`,
    `SUMMARY:${SUMMARY}`,
    `DESCRIPTION:${escape(`Course: ${course}. Open Codemm. A due review comes first, then your next topic.`)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${SUMMARY}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

/** A TEXT value: backslash, semicolon, comma and line breaks escaped. */
const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a line at 75 octets (a continuation starts with one space), never inside a character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 75) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n');
}
