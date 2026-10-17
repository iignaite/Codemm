// desktop.json in the app's userData folder (DESIGN §2): the chosen agent and
// the tutor's session per course. It carries format_version and is written
// atomically, like every Codemm-owned file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId } from '../shared/api';

export interface DesktopState {
  format_version: 1;
  agent?: AgentId;
  /** Tutor session or thread ids, keyed `course|agent`. */
  sessions: Record<string, string>;
  /** The course whose roadmap the learner approved. Before that, it is a draft and no work starts (§4.2). */
  approved?: string;
}

export function desktopState(dir: string) {
  const file = join(dir, 'desktop.json');
  const read = (): DesktopState => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return { format_version: 1, sessions: {} };
    }
    const parsed = JSON.parse(raw) as DesktopState;
    if (parsed.format_version !== 1) throw new Error(`Unknown format_version in ${file}`);
    return parsed;
  };
  return {
    read,
    update(change: (s: DesktopState) => DesktopState): DesktopState {
      const next = change(read());
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(temp, file);
      return next;
    },
  };
}
