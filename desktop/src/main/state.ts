// desktop.json in the app's userData folder (DESIGN §2): the chosen agent, the
// workspace folder, and the tutor's session per course. It carries format_version and is written
// atomically, like every Codemm-owned file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId } from '../shared/api';

export interface DesktopState {
  format_version: 1;
  agent?: AgentId;
  /** The workspace folder, when it isn't ~/Codemm (O5). */
  workspace?: string;
  /** Tutor session or thread ids, keyed `course|agent`. */
  sessions: Record<string, string>;
  /** The course on screen, one the learner approved. Before approval a roadmap is a draft and no work starts (§4.2). */
  approved?: string;
  /** Every course the learner approved, oldest first (§4.13). A file from before several courses has `approved` alone. */
  courses?: string[];
  /** The words the learner typed for each course researched before roadmaps had titles: its name on screen (W-5). */
  names?: Record<string, string>;
  /** The coding style to restore after turning activities off. */
  activityStyles?: Record<string, string>;
  /** The learner's model choice per agent (O6). Absent: the recommended one. */
  models?: Partial<Record<AgentId, string>>;
}

export const workspaceOf = (state: DesktopState, home: string) => state.workspace ?? join(home, 'Codemm');

/** The learner's courses, oldest first (§4.13). */
export const coursesOf = (state: DesktopState): string[] => state.courses ?? (state.approved ? [state.approved] : []);

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
