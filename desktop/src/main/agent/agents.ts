// What differs between agent CLIs (docs/desktop/DESIGN.md §3.1, proved in the
// agent-bridge spike): how to launch a headless turn with Codemm's MCP server,
// how to read its JSON stream as common events, and how to ask its version and
// whether the learner is signed in.
import type { AgentId } from '../../shared/api';
import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';

export { PLAN_LIMIT, readOf, STEP_LABELS } from './stream';

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string }
  /** A failed result keeps a little of its text, only to tell infrastructure failures apart (§6.1). */
  | { type: 'tool_result'; id: string; error: boolean; text?: string }
  /** The Codemm server failed to start. */
  | { type: 'server'; ok: false }
  | { type: 'done'; ok: boolean; error?: string }
  /**
   * What the agent is looking at: a web search, an https page, or one of Codemm's steps (research progress). `id` is
   * the tool call of a page fetch still under way: it counts as a source only if that call succeeds.
   */
  | { type: 'progress'; step: ResearchStep; id?: string }
  /**
   * What the run used, as the CLI reported it: every input token (`cachedInput` of them read from cache) and output
   * tokens. `costUsd` is Claude's own estimate; on a resumed session it counts the whole session so far.
   */
  | { type: 'usage'; input: number; output: number; cachedInput?: number; costUsd?: number };

/**
 * One step a job shows while it runs. `read` keeps the full https `href` for the roadmap's sources and shows only
 * host and path. Nothing here ever comes from a file path, a file's contents or Codemm's records.
 */
export type ResearchStep = { kind: 'search'; query: string } | { kind: 'read'; url: string; href?: string } | { kind: 'step'; label: string };

/** How an agent starts Codemm's MCP server for one job. */
export interface McpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Turn {
  prompt: string;
  server: McpServer;
  /** The job's Codemm tools: the only ones the agent may call. */
  tools: string[];
  model?: string;
  /** A session or thread id to continue (tutor turns). */
  resume?: string;
  /** Built-in tools the job may use; only the research job gets web search and fetch (§3.2). */
  web?: boolean;
  /** How long one Codemm tool call may run: the job's deadline. */
  toolTimeoutSec?: number;
}

/** A command the agent CLI runs; `command` is resolved to an executable later. */
export interface Invocation {
  args: string[];
  /** Config the agent reads from its working directory, by relative path: the job runs in a folder holding only these. */
  files?: Record<string, string>;
}

export interface StatusCommand<T> {
  args: string[];
  read: (r: { code: number | null; output: string }) => T;
}

export interface AgentCli {
  /** The executable name looked up on PATH. */
  bin: string;
  launch?: (turn: Turn) => Invocation;
  parse?: (line: string) => AgentEvent[];
  /** Reads a stderr line for a known failure, keeping only a fixed message: stderr can carry account details. */
  errors?: (line: string) => AgentEvent[];
  version: StatusCommand<string | null>;
  signIn: StatusCommand<boolean>;
}

/** The CLI versions the recorded fixtures come from (§3.3). */
export const TESTED: Record<AgentId, string[]> = { claude: ['2.1.283'], codex: ['0.156.1'], cursor: ['2026.10.16-e3cb207'] };
export const isTested = (agent: AgentId, version: string) => TESTED[agent].includes(version);

export const AGENT_CLIS: Record<AgentId, AgentCli> = { claude, codex, cursor };
