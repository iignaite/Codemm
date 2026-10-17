// The app's own log, for support (DESIGN §5): job lifecycle, what detection
// found, and errors. Callers pass an event name and short fields, never learner
// code, hidden data, briefs or agent text. Every value is still redacted,
// trimmed to one short line, and the file rotates at its cap.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Fields = Record<string, string | number | boolean | undefined>;
export type Log = (event: string, fields?: Fields) => void;

/** One file of at most this many bytes, plus one older file. */
const CAP = 2 * 1024 * 1024;
const VALUE_MAX = 200;

const SECRETS: RegExp[] = [
  /\b(bearer|basic)\s+\S+/gi,
  /\b([\w-]*(key|token|secret|password|passwd|auth|cookie|session)[\w-]*)\s*[=:]\s*\S+/gi,
  /\b(sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][\w-]{8,}/g,
  /\b[A-Za-z0-9+_=-]{32,}\b/g,
];

export function redact(value: string): string {
  let text = value.split(homedir()).join('~');
  for (const pattern of SECRETS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text;
}

const format = (value: string | number | boolean) => (typeof value === 'string' ? JSON.stringify(redact(value)).replace(/^"([\w.@:/~-]*)"$/, '$1') : String(value));

export function createLog(dir: string, cap = CAP): Log {
  const file = join(dir, 'codemm.log');
  return (event, fields = {}) => {
    try {
      const parts = Object.entries(fields).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${format(v)}`]));
      const line = `${new Date().toISOString()} ${event}${parts.length ? ` ${parts.join(' ')}` : ''}\n`;
      mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // No log yet.
      }
      if (size > 0 && size + line.length > cap) renameSync(file, join(dir, 'codemm.1.log'));
      appendFileSync(file, line);
    } catch {
      // Logging never breaks the app.
    }
  };
}

/** For tests and the mock: logs nothing. */
export const noLog: Log = () => {};
