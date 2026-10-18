// Agent jobs (DESIGN §3.2): each runs with a short brief, a Codemm server that
// exposes only its tools, a deadline and a bound on failed saves, and is done
// only when its check against core records passes, never on the agent's word.
import type { AgentId } from '../../shared/api';
import { AGENT_CLIS, type AgentEvent, type McpServer, type ResearchStep } from './agents';
import { spendsNoRetry } from '../core/failures';
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

/** `infra`: Docker, disk, network or the Codemm server failed: nothing is recorded and no attempt is spent (§6.1). `unstoppable`: a cancel the agent survived. */
export type JobProblem = 'plan-limit' | 'signed-out' | 'failed' | 'infra' | 'unstoppable';

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
  /** True once no agent may launch: another job's agent couldn't be stopped (§3.1). */
  blocked?: () => boolean;
  /** Asked when a job fails for an unknown reason. */
  signedIn: () => Promise<boolean>;
  deadlineMs?: number;
  /** Hears what the agent is looking at (research progress). */
  onProgress?: (step: ResearchStep) => void;
}

interface Attempt {
  ok: boolean;
  error?: string;
  session?: string;
  text: string[];
  /** A cancel the agent's process group survived (§3.1). */
  unstoppable: boolean;
  /** `server`: the Codemm server didn't start. `tool`: a Codemm tool hit Docker, disk or network. `unstarted`: the agent exited before it started. */
  infra?: 'server' | 'tool' | 'unstarted';
}

async function once(job: Job): Promise<Attempt> {
  const cli = AGENT_CLIS[job.agent];
  if (!cli.launch || !cli.parse) return { ok: false, error: 'This agent is experimental and can not run jobs yet.', text: [], unstoppable: false };
  const spec = JOBS[job.kind];
  const deadlineMs = job.deadlineMs ?? spec.deadlineMs;
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), deadlineMs);
  const cancel = () => stop.abort();
  job.signal?.addEventListener('abort', cancel, { once: true });
  const saves = new Set<string>();
  let failedSaves = 0;
  let session: string | undefined;
  let done: AgentEvent & { type: 'done' } | undefined;
  let started = false;
  let infra: Attempt['infra'];
  const text: string[] = [];
  const onEvent = (e: AgentEvent) => {
    started = true;
    if (e.type === 'session') session = e.id;
    if (e.type === 'text') text.push(e.text);
    if (e.type === 'done') done = e;
    if (e.type === 'progress') job.onProgress?.(e.step);
    if (e.type === 'server') {
      infra = 'server';
      stop.abort();
    }
    if (e.type === 'tool_call' && spec.save && e.name === `codemm.${spec.save}`) saves.add(e.id);
    if (e.type === 'tool_result' && e.error && e.text && spendsNoRetry(e.text)) {
      infra = 'tool';
      stop.abort();
    }
    if (e.type === 'tool_result' && e.error && saves.has(e.id) && ++failedSaves >= SAVE_BOUND) stop.abort();
  };
  const turn = { prompt: job.brief, server: job.server(spec.tools), tools: spec.tools, model: job.model, resume: job.resume, web: spec.web, toolTimeoutSec: Math.ceil(deadlineMs / 1000) };
  try {
    const result = await run(job.exe, cli.launch(turn).args, cli.parse, { onEvent, signal: stop.signal, cwd: job.cwd, runtime: job.runtime });
    if (!started && !result.cancelled && result.code !== 0) infra ??= 'unstarted';
    // A conversational success needs the agent's done event and a clean exit.
    const ok = !result.cancelled && result.code === 0 && done?.ok === true;
    return { ok, error: done?.error, session, text, unstoppable: result.cancelled && result.stopped === false, infra };
  } finally {
    clearTimeout(deadline);
    job.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Runs a job and checks it against core records. A failed job is relaunched at most once, never after
 * a plan limit, a sign-out or an infrastructure failure, never while its agent may still be running,
 * and never when its save landed anyway (a save can commit just before a crash).
 */
export async function runJob(job: Job): Promise<JobOutcome> {
  let last: Attempt | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (job.signal?.aborted) break;
    // Checked before every launch, the relaunch included.
    if (job.blocked?.()) return { ok: false, problem: 'unstoppable', text: last?.text ?? [] };
    last = await once(job);
    if (last.unstoppable) return { ok: false, problem: 'unstoppable', text: last.text };
    if (await job.done({ ok: last.ok })) return { ok: true, session: last.session, text: last.text };
    if (job.signal?.aborted) break;
    if (last.error && PLAN_LIMIT.test(last.error)) return { ok: false, problem: 'plan-limit', text: last.text };
    if (last.infra === 'server' || last.infra === 'tool') return { ok: false, problem: 'infra', text: last.text };
    if (!(await job.signedIn())) return { ok: false, problem: 'signed-out', text: last.text };
    if (last.infra === 'unstarted') return { ok: false, problem: 'infra', text: last.text };
  }
  return { ok: false, problem: 'failed', session: last?.session, text: last?.text ?? [] };
}
