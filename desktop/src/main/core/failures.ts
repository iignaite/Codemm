// Core's infrastructure failures. They are this computer's problems: nothing is
// recorded, no agent retry is spent, and the learner can fix them (DESIGN §5, §6.1).

/**
 * What the learner is told: Docker isn't there or isn't running, is busy and not answering, or answers but failed;
 * Docker's disk is full, or this computer's; or the network failed.
 */
export type Infra = 'docker' | 'docker-busy' | 'docker-failed' | 'docker-disk' | 'disk' | 'offline';

/** core src/errors.ts INFRA: each of core's codes, and what the learner is told about it. */
const CODES = {
  'no-runtime': 'docker',
  'no-wasmtime': 'docker-failed',
  'runtime-down': 'docker',
  'runtime-paused': 'docker',
  'socket-permission': 'docker',
  'runtime-context': 'docker',
  'runtime-busy': 'docker-busy',
  'check-timeout': 'docker-busy',
  'container-remove': 'docker-busy',
  'windows-containers': 'docker-failed',
  credentials: 'docker-failed',
  'container-start': 'docker-failed',
  'docker-cpus': 'docker-failed',
  'docker-log-driver': 'docker-failed',
  'docker-file-sharing': 'docker-failed',
  'runtime-failed': 'docker-failed',
  'image-id': 'docker-failed',
  'image-inspect': 'docker-failed',
  'container-list': 'docker-failed',
  'docker-disk': 'docker-disk',
  'host-disk': 'disk',
  offline: 'offline',
  'rate-limit': 'offline',
  tls: 'offline',
  'network-timeout': 'offline',
} as const satisfies Record<string, Infra>;

/** Which of core's failures it was, for the app log: core's code, or `other` for a kind without one. */
export type Cause = keyof typeof CODES | 'other';

export interface Failure {
  infra: Infra;
  cause: Cause;
}

/** core src/errors.ts ErrorKind: what kind of failure a CodemmError is. */
export type CoreErrorKind = 'no-course' | 'image-missing' | 'damaged' | 'changed' | 'docker' | 'disk' | 'offline';

const fromCore = (e: unknown): (Error & { kind?: CoreErrorKind; code?: unknown }) | undefined =>
  e instanceof Error && e.name === 'CodemmError' ? e : undefined;

/** The kind core gave an error it threw in this process, if any. */
export const kindOf = (e: unknown): CoreErrorKind | undefined => fromCore(e)?.kind;

const failureOf = (code: unknown): Failure | null => (typeof code === 'string' && Object.hasOwn(CODES, code) ? { cause: code as keyof typeof CODES, infra: CODES[code as keyof typeof CODES] } : null);

/**
 * The code a tool result starts with: core's MCP server writes `codemm:<code or kind>` as the first line of a failure
 * (src/mcp.ts), and nothing else can write there. An agent may put its own words before it on that line.
 */
const tagOf = (text: string) => /^[^\n]*?\bcodemm:([a-z][a-z-]*)(?:\n|$)/.exec(text)?.[1];

/** This computer's problem, from a tool result's code: what an agent relays back over MCP carries no error object. */
export const infra = (text: string): Failure | null => failureOf(tagOf(text));

/** A tool result that says a track image needs a rebuild. */
export const needsRebuild = (text: string): boolean => tagOf(text) === 'image-missing';

/** This computer's problem behind an error thrown in this process: core's code, or a write that ran out of space. */
export function infraOf(e: unknown): Failure | null {
  const core = fromCore(e);
  const coded = failureOf(core?.code);
  if (coded) return coded;
  // A kind without a code: what Docker or the disk said before codes. Docker reads as stopped, as it always has.
  if (core?.kind === 'docker' || core?.kind === 'disk' || core?.kind === 'offline') return { infra: core.kind, cause: 'other' };
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC' ? { infra: 'disk', cause: 'host-disk' } : null;
}
