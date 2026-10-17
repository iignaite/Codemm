// Agent jobs (DESIGN §3.2): each runs with a short brief, a Codemm server that
// exposes only its tools, a deadline and a bound on failed saves, and is done
// only when its check against core records passes, never on the agent's word.
import type { AgentId } from '../../shared/api';
import { AGENT_CLIS, type AgentEvent, type McpServer } from './agents';
import { run, type Executable } from './bridge';

export type JobKind = 'research' | 'roadmap' | 'setup' | 'lesson' | 'author' | 'tutor';

interface JobSpec {
  tools: string[];
  deadlineMs: number;
  /** The save tool whose failures count toward the bound. */
  save?: string;
  web?: boolean;
}

const MIN = 60_000;
export const JOBS: Record<JobKind, JobSpec> = {
  research: { tools: ['list_tracks', 'save_roadmap'], deadlineMs: 10 * MIN, web: true },
  roadmap: { tools: ['get_roadmap', 'save_roadmap'], deadlineMs: 10 * MIN },
  setup: { tools: ['list_tracks', 'save_track'], deadlineMs: 10 * MIN },
  lesson: { tools: ['get_roadmap', 'save_lesson'], deadlineMs: 5 * MIN, save: 'save_lesson' },
  author: { tools: ['next_step', 'save_exercise'], deadlineMs: 15 * MIN, save: 'save_exercise' },
  tutor: { tools: ['progress', 'next_step', 'get_exercise', 'get_lesson', 'mark_lesson_read', 'get_roadmap', 'list_tracks'], deadlineMs: 5 * MIN },
};

/** Failed saves that end a job (§3.2). */
export const SAVE_BOUND = 3;

/** Known plan-limit markers in an agent's `done` error (§6.1). Unverified until each is recorded as a fixture. */
const PLAN_LIMIT = /usage limit|rate limit|\b429\b/i;

export type JobProblem = 'plan-limit' | 'signed-out' | 'failed';

export interface JobOutcome {
  ok: boolean;
  problem?: JobProblem;
  session?: string;
  /** The agent's text, for tutor and roadmap-change turns only. */
  text: string[];
}

export interface Job {
  kind: JobKind;
  agent: AgentId;
  exe: Executable;
  /** The app's own executable, which runs Node scripts (§3.1). */
  runtime?: string;
  brief: string;
  /** Builds the job's server for its tools. */
  server: (tools: string[]) => McpServer;
  cwd: string;
  model?: string;
  resume?: string;
  signal?: AbortSignal;
  /** Checked against core records created after the job started; a tutor turn passes when it ends without error. */
  done: (turn: { ok: boolean }) => boolean | Promise<boolean>;
  /** Asked when a job fails for an unknown reason. */
  signedIn: () => Promise<boolean>;
  deadlineMs?: number;
}

async function once(job: Job): Promise<{ ok: boolean; error?: string; session?: string; text: string[]; cancelled: boolean }> {
  const cli = AGENT_CLIS[job.agent];
  if (!cli.launch || !cli.parse) return { ok: false, error: 'This agent is experimental and can not run jobs yet.', text: [], cancelled: false };
  const spec = JOBS[job.kind];
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), job.deadlineMs ?? spec.deadlineMs);
  job.signal?.addEventListener('abort', () => stop.abort(), { once: true });
  const saves = new Set<string>();
  let failedSaves = 0;
  let session: string | undefined;
  let done: AgentEvent & { type: 'done' } | undefined;
  const text: string[] = [];
  const onEvent = (e: AgentEvent) => {
    if (e.type === 'session') session = e.id;
    if (e.type === 'text') text.push(e.text);
    if (e.type === 'done') done = e;
    if (e.type === 'tool_call' && spec.save && e.name === `codemm.${spec.save}`) saves.add(e.id);
    if (e.type === 'tool_result' && e.error && saves.has(e.id) && ++failedSaves >= SAVE_BOUND) stop.abort();
  };
  const args = cli.launch({ prompt: job.brief, server: job.server(spec.tools), tools: spec.tools, model: job.model, resume: job.resume, web: spec.web }).args;
  try {
    const result = await run(job.exe, args, cli.parse, { onEvent, signal: stop.signal, cwd: job.cwd, runtime: job.runtime });
    return { ok: !result.cancelled && done?.ok === true, error: done?.error, session, text, cancelled: result.cancelled };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Runs a job and checks it against core records. A failed job is relaunched at most once, never after
 * a plan limit or sign-out, and never when its save landed anyway (a save can commit just before a crash).
 */
export async function runJob(job: Job): Promise<JobOutcome> {
  let last: Awaited<ReturnType<typeof once>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await once(job);
    if (await job.done({ ok: last.ok })) return { ok: true, session: last.session, text: last.text };
    if (job.signal?.aborted) break;
    if (last.error && PLAN_LIMIT.test(last.error)) return { ok: false, problem: 'plan-limit', text: last.text };
    if (!(await job.signedIn())) return { ok: false, problem: 'signed-out', text: last.text };
  }
  return { ok: false, problem: 'failed', session: last?.session, text: last?.text ?? [] };
}
