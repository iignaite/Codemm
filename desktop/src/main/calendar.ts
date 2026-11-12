// The practice time's calendar file (DESIGN §4.15): one repeating event in standard iCalendar (RFC 5545), which every
// calendar app imports. Codemm has no server, so the learner's own calendar brings them back.

import type { PracticeTime } from '../shared/api';

const SUMMARY = 'Practice with Codemm';
const RRULE = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' };

/**
 * The calendar file for a practice time: the first day it fits, today if the time is still ahead, never a weekend for
 * weekdays. `uid` names the series, so saving again for the same course replaces it in the calendar (with SEQUENCE).
 */
export function practiceCalendar({ time, repeat, course, now, uid }: PracticeTime & { course: string; now: Date; uid: string }): string {
  const [hour, minute] = time.split(':').map(Number);
  // The day only: the time is written as chosen, so an hour a clock change skips stays the hour the learner picked.
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const ahead = now.getHours() * 60 + now.getMinutes() < hour * 60 + minute;
  if (!ahead) day.setDate(day.getDate() + 1);
  while (repeat === 'weekdays' && (day.getDay() === 0 || day.getDay() === 6)) day.setDate(day.getDate() + 1);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Codemm//Practice time//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@codemm`,
    // Minutes since 1970: a later save of the same series replaces an earlier one.
    `SEQUENCE:${Math.floor(now.getTime() / 60_000)}`,
    `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    // Floating local time: the event follows the learner's time zone.
    `DTSTART:${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}T${pad(hour)}${pad(minute)}00`,
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

/** A TEXT value: backslash, semicolon, comma and every line break escaped, other control characters but tab dropped. */
const escape = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

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
