// One agent job's progress (DESIGN §4.11), read from the bridge's common events: the stage it has reached, its
// latest steps (searches, pages, Codemm's own steps), retries, and how long it has run and been quiet. It keeps
// nothing from a tool's arguments or results, a file or Codemm's records: only fixed labels, queries and pages.
import { randomUUID } from 'node:crypto';
import type { JobKind, JobProgress, JobStep } from '../../shared/api';
import { JOB_STAGES } from '../../shared/progress';
import type { AgentEvent } from './agents';
import { JOBS, SAVE_BOUND } from './jobs';

/** The tool whose call reaches a job's last stage: its save. Setup only proposes, so it stays on its first stage. */
const SAVES: Partial<Record<JobKind, string>> = { research: 'save_roadmap', roadmap: 'save_roadmap', lesson: 'save_lesson', author: 'save_exercise' };
const KEPT = 8;

export interface TrackerOptions {
  id?: string;
  concept?: string;
  now?: () => number;
  /** False for text that must not be shown: the reply filter's backstop (§2.2). */
  shows?: (text: string) => boolean;
  /** The job is itself a retry: another setup proposal after one failed its gates. */
  retry?: JobProgress['retry'];
}

export type JobTracker = ReturnType<typeof jobTracker>;

export function jobTracker(kind: JobKind, { id = randomUUID(), concept, now = Date.now, shows = () => true, retry: first }: TrackerOptions = {}) {
  const started = now();
  const last = JOB_STAGES[kind].length - 1;
  let stage = 0;
  let lastEvent = started;
  let steps: JobStep[] = [];
  let count = 0;
  let retry: JobProgress['retry'] = first;
  /** Codemm itself is working (a setup's build), not the agent. */
  let codemm = false;
  let failedSaves = 0;
  const open = new Set<string>();
  const saves = new Set<string>();
  /** The author's next_step call: once it has its target, it writes. */
  const targets = new Set<string>();
  const reach = (n: number) => (stage = Math.max(stage, Math.min(n, last)));

  function step(s: JobStep & { href?: string }) {
    const shown: JobStep = s.kind === 'read' ? { kind: 'read', url: s.url } : s;
    const text = s.kind === 'search' ? s.query : s.kind === 'read' ? (s.href ?? s.url) : s.label;
    if (!shows(text)) return;
    steps = [shown, ...steps].slice(0, KEPT);
    count++;
  }

  return {
    id,
    /** Reads one of the bridge's events. Unknown kinds only count as activity. */
    event(e: AgentEvent) {
      lastEvent = now();
      if (kind !== 'setup') reach(1);
      if (e.type === 'progress') step(e.step);
      if (e.type === 'tool_call' && e.name.startsWith('codemm.')) {
        open.add(e.id);
        if (kind === 'author' && e.name === 'codemm.next_step') targets.add(e.id);
        if (e.name === `codemm.${SAVES[kind]}`) {
          saves.add(e.id);
          reach(2);
        }
      }
      if (e.type === 'tool_result') {
        open.delete(e.id);
        if (targets.delete(e.id) && !e.error) step({ kind: 'step', label: 'Writing the exercise' });
        // A rejected save sends the agent back to its work. Only bounded saves count toward "Trying again".
        if (e.error && saves.delete(e.id)) {
          stage = 1;
          if (JOBS[kind].save) retry = { attempt: Math.min(++failedSaves + 1, SAVE_BOUND), of: SAVE_BOUND };
        }
      }
    },
    /** Codemm's own work reached a stage: a setup's build, then its checks. */
    reach(n: number) {
      lastEvent = now();
      codemm = true;
      stage = Math.min(n, last);
    },
    /** The job's agent runs again after a failure (§3.2): it starts over. */
    relaunch() {
      lastEvent = now();
      stage = 0;
      failedSaves = 0;
      open.clear();
      saves.clear();
      targets.clear();
      retry = { attempt: 2, of: 2 };
    },
    snapshot(): JobProgress {
      const t = now();
      return {
        job: id,
        kind,
        ...(concept ? { concept } : {}),
        stage,
        steps,
        count,
        ...(retry ? { retry } : {}),
        thinking: open.size === 0 && !codemm,
        elapsedMs: t - started,
        idleMs: t - lastEvent,
      };
    },
  };
}
