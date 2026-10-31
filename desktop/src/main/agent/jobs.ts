// Agent jobs (DESIGN §3.2): each runs with a short brief, a Codemm server that
// exposes only its tools, a deadline and a bound on failed saves, and is done
// only when its check against core records passes, never on the agent's word.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentId, AgentJobKind } from '../../shared/api';
import { AGENT_CLIS, PLAN_LIMIT, type AgentEvent, type Invocation, type McpServer } from './agents';
import { infra as failureIn, infraOf, needsRebuild, type Cause, type Failure, type Infra } from '../core/failures';
import { run, type Executable } from './bridge';
import { CHANGE_APPROACH } from './briefs';

/** A job the agent runs: the kinds of progress that aren't Codemm's own (shared/api.ts). */
export type JobKind = AgentJobKind;

interface JobSpec {
  tools: string[];
  deadlineMs: number;
  /** The save tool whose failures count toward the bound. */
  save?: string;
  web?: boolean;
  /** A failed job relaunches once unless false. */
  relaunch?: boolean;
  /** A relaunch continues the failed attempt's session, told to change its approach, instead of starting fresh. */
  resumes?: true;
}

const MIN = 60_000;
export const JOBS: Record<JobKind, JobSpec> = {
  research: { tools: ['list_tracks', 'save_roadmap'], deadlineMs: 10 * MIN, web: true },
  review: { tools: ['get_roadmap', 'save_roadmap'], deadlineMs: 5 * MIN, web: true, relaunch: false },
  roadmap: { tools: ['get_roadmap', 'save_roadmap'], deadlineMs: 10 * MIN },
  setup: { tools: ['list_tracks', 'save_track'], deadlineMs: 10 * MIN, web: true },
  lesson: { tools: ['get_roadmap', 'save_lesson'], deadlineMs: 5 * MIN, save: 'save_lesson' },
  author: { tools: ['next_step', 'save_exercise'], deadlineMs: 15 * MIN, save: 'save_exercise', resumes: true },
  tutor: { tools: ['progress', 'next_step', 'get_exercise', 'get_lesson', 'mark_lesson_read', 'get_roadmap', 'list_tracks'], deadlineMs: 5 * MIN },
};

/** Failed saves that end a job (§3.2). */
export const SAVE_BOUND = 3;

/** Network errors in an agent's `done` error: it couldn't reach its own service (§6.1). PLAN_LIMIT lives with the agents. */
export const OFFLINE = /connection error|ENOTFOUND|EAI_AGAIN|network is unreachable|could not resolve host|error sending request|connection lost/i;

/**
 * An Infra problem: this computer's Docker (stopped, busy, or failing while it runs), disk or network stopped a save,
 * or removing an ended attempt's containers. `rebuild`: a track image needs a rebuild. `infra`: the Codemm server or
 * the agent failed to start. None records anything or spends an attempt (§6.1). `unstoppable`: a cancel the agent
 * survived.
 */
export type JobProblem = 'plan-limit' | 'signed-out' | 'failed' | 'infra' | 'rebuild' | Infra | 'unstoppable';

export interface JobOutcome {
  ok: boolean;
  problem?: JobProblem;
  /** Which of core's failures stopped it, when a Codemm tool said so: a fixed label for the app log. */
  cause?: Cause;
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
  /** A Codemm-owned folder for agents that read their config from the working directory (Cursor). */
  agentDir?: string;
  model?: string;
  resume?: string;
  signal?: AbortSignal;
  /** Checked against core records created after the job started; a tutor turn passes when it ends without error. */
  done: (turn: { ok: boolean }) => boolean | Promise<boolean>;
  /** True once no agent may launch: another job's agent couldn't be stopped (§3.1). */
  blocked?: () => boolean;
  /** False once Codemm has started installing this agent again: nothing of it launches until that install is done (§3.1). */
  usable?: () => boolean;
  /** Asked when a job fails for an unknown reason. */
  /** Null when the agent's sign-in check couldn't answer: a timeout, or offline. */
  signedIn: () => Promise<boolean | null>;
  /**
   * Removes the containers of Codemm processes that are gone (core's removeAbandoned), after an attempt Codemm ended:
   * a cancelled job's gate container would otherwise run on beside the next one (§5).
   */
  cleanup?: () => Promise<void>;
  deadlineMs?: number;
  /** Hears each of the agent's events, for the job's progress (§4.11). */
  onEvent?: (event: AgentEvent) => void;
  /** Hears that a failed job's agent is about to run again. */
  onRelaunch?: () => void;
  /** Hears each https page the agent read successfully, for the roadmap's sources. */
  onSource?: (source: { title: string; url: string }) => void;
  /** What a run used, as its CLI reported it, with its session (§4.12). */
  onUsage?: (usage: { input: number; output: number; cachedInput?: number; costUsd?: number; session?: string }) => void;
}

interface Attempt {
  ok: boolean;
  error?: string;
  session?: string;
  text: string[];
  /** A cancel the agent's process group survived (§3.1). */
  unstoppable: boolean;
  /** Codemm ended the attempt (a cancel, the deadline, or a failure that stops it), so it may have left containers. */
  ended: boolean;
  /**
   * `server`: the Codemm server didn't start. A Codemm tool hit this computer's Docker, disk or network, or
   * (`rebuild`) a track image that needs a rebuild. `unstarted`: the agent exited before it started.
   */
  infra?: 'server' | 'rebuild' | 'unstarted' | Infra;
  cause?: Cause;
}

/**
 * The folder an agent with config files runs in: named by its config, so the same job config gets the same folder
 * (Cursor keeps chats per working directory, so a tutor turn resumes). Each file is written whole, then renamed.
 */
function jobFolder(agentDir: string, agent: AgentId, files: NonNullable<Invocation['files']>): string {
  const folder = join(agentDir, `${agent}-${createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)}`);
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, path);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, file);
  }
  return folder;
}

async function once(job: Job): Promise<Attempt> {
  const cli = AGENT_CLIS[job.agent];
  if (!cli.launch || !cli.parse) return { ok: false, error: 'This agent is experimental and can not run jobs yet.', text: [], unstoppable: false, ended: false };
  const spec = JOBS[job.kind];
  const deadlineMs = job.deadlineMs ?? spec.deadlineMs;
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), deadlineMs);
  const cancel = () => stop.abort();
  job.signal?.addEventListener('abort', cancel, { once: true });
  const saves = new Set<string>();
  /** Calls of Codemm's own tools: only their results can carry core's code (the agent's other tools say anything). */
  const ours = new Set<string>();
  let failedSaves = 0;
  let session: string | undefined;
  let done: AgentEvent & { type: 'done' } | undefined;
  let started = false;
  let infra: Attempt['infra'];
  let cause: Cause | undefined;
  const text: string[] = [];
  const reads = new Map<string, { title: string; url: string }>();
  const onEvent = (e: AgentEvent) => {
    started = true;
    if (e.type === 'session') session = e.id;
    if (e.type === 'usage') {
      const { type: _, ...used } = e;
      job.onUsage?.({ ...used, ...(session ? { session } : {}) });
    }
    if (e.type === 'text') text.push(e.text);
    if (e.type === 'done') done = e;
    job.onEvent?.(e);
    if (e.type === 'progress') {
      // A Claude fetch counts once its call succeeds; a Codex page read arrives already done.
      if (e.step.kind === 'read' && e.step.href) {
        const source = { title: e.step.url, url: e.step.href };
        if (e.id) reads.set(e.id, source);
        else job.onSource?.(source);
      }
    }
    if (e.type === 'tool_result' && reads.has(e.id)) {
      if (!e.error) job.onSource?.(reads.get(e.id)!);
      reads.delete(e.id);
    }
    if (e.type === 'server') {
      infra = 'server';
      stop.abort();
    }
    if (e.type === 'tool_call' && /^codemm\./i.test(e.name)) ours.add(e.id);
    if (e.type === 'tool_call' && spec.save && e.name === `codemm.${spec.save}`) saves.add(e.id);
    // Only core's code on a Codemm tool result's first line says it's this computer's problem, never any other text.
    const coreSaid = e.type === 'tool_result' && e.error && e.text && ours.has(e.id) ? e.text : undefined;
    const failure = coreSaid ? failureIn(coreSaid) : null;
    if (failure || (coreSaid && needsRebuild(coreSaid))) {
      infra = failure?.infra ?? 'rebuild';
      cause = failure?.cause;
      stop.abort();
    }
    if (e.type === 'tool_result' && e.error && saves.has(e.id) && ++failedSaves >= SAVE_BOUND) stop.abort();
  };
  const turn = { prompt: job.brief, server: job.server(spec.tools), tools: spec.tools, model: job.model, resume: job.resume, web: spec.web, toolTimeoutSec: Math.ceil(deadlineMs / 1000) };
  try {
    const { args, files } = cli.launch(turn);
    if (files && !job.agentDir) throw new Error(`${job.agent} needs a folder for its config`);
    const cwd = files ? jobFolder(job.agentDir!, job.agent, files) : job.cwd;
    const result = await run(job.exe, args, cli.parse, { onEvent, signal: stop.signal, cwd, runtime: job.runtime, errors: cli.errors });
    if (!started && !result.cancelled && result.code !== 0) infra ??= 'unstarted';
    // A conversational success needs the agent's done event and a clean exit.
    const ok = !result.cancelled && result.code === 0 && done?.ok === true;
    return { ok, error: done?.error, session, text, unstoppable: result.cancelled && result.stopped === false, ended: result.cancelled, infra, cause };
  } finally {
    clearTimeout(deadline);
    job.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Runs a job and checks it against core records. A failed job is relaunched at most once, never after
 * a plan limit, a sign-out or an infrastructure failure, never while its agent or its container may still be running,
 * and never when its save landed anyway (a save can commit just before a crash).
 */
export async function runJob(job: Job): Promise<JobOutcome> {
  let last: Attempt | undefined;
  for (let attempt = 0; attempt < (JOBS[job.kind].relaunch === false ? 1 : 2); attempt++) {
    if (job.signal?.aborted) break;
    // Checked before every launch, the relaunch included.
    if (job.blocked?.()) return { ok: false, problem: 'unstoppable', text: last?.text ?? [] };
    if (job.usable?.() === false) return { ok: false, problem: 'signed-out', text: last?.text ?? [] };
    if (attempt > 0) job.onRelaunch?.();
    // An author relaunches in its own session (it knows what it tried), told to change its approach.
    const again = attempt > 0 && JOBS[job.kind].resumes && last?.session ? { ...job, resume: last.session, brief: `${job.brief}\n\n${CHANGE_APPROACH}` } : job;
    last = await once(again);
    // An agent that won't continue the session (it exited before starting) gets the fresh relaunch instead.
    if (again !== job && last.infra === 'unstarted' && !job.signal?.aborted && !job.blocked?.() && job.usable?.() !== false) last = await once(job);
    // Said at once: the caller stops every other agent on this, and a cleanup waiting on Docker must not delay it.
    if (last.unstoppable) return { ok: false, problem: 'unstoppable', text: last.text };
    // Before a relaunch or the end, an attempt Codemm ended leaves no container behind. Why a cleanup failed is
    // Docker's to say: busy, or answering but failing. A busy Docker would only keep the learner waiting on it, and
    // nothing relaunches after it: a later cleanup removes what's left once this attempt's processes are gone.
    const tidy = last.ended && job.cleanup && last.infra !== 'docker-busy';
    const unclean = tidy ? await job.cleanup!().then((): Failure | null => null, (e: unknown): Failure => infraOf(e) ?? { infra: 'docker-failed', cause: 'other' }) : null;
    if (await job.done({ ok: last.ok })) return { ok: true, session: last.session, text: last.text };
    if (job.signal?.aborted) break;
    if (last.error && PLAN_LIMIT.test(last.error)) return { ok: false, problem: 'plan-limit', text: last.text };
    if (last.infra === 'offline' || (last.error && OFFLINE.test(last.error))) return { ok: false, problem: 'offline', cause: last.cause, text: last.text };
    if (last.infra === 'rebuild') return { ok: false, problem: 'rebuild', text: last.text };
    if (last.infra && last.infra !== 'server' && last.infra !== 'unstarted') return { ok: false, problem: last.infra, cause: last.cause, text: last.text };
    if (last.infra === 'server') return { ok: false, problem: 'infra', text: last.text };
    if ((await job.signedIn()) === false) return { ok: false, problem: 'signed-out', text: last.text };
    if (last.infra === 'unstarted') return { ok: false, problem: 'infra', text: last.text };
    // Its container may still run, so no relaunch joins it.
    if (unclean) return { ok: false, problem: unclean.infra, cause: unclean.cause, text: last.text };
  }
  return { ok: false, problem: 'failed', session: last?.session, text: last?.text ?? [] };
}
