// Core's infrastructure failures. They are this computer's problems: nothing is
// recorded, no agent retry is spent, and the learner can fix them (DESIGN §5, §6.1).
export type Infra = 'disk' | 'offline' | 'docker';

/** core src/errors.ts ErrorKind: what kind of failure a CodemmError is. */
export type CoreErrorKind = 'no-course' | 'image-missing' | 'damaged' | 'changed' | 'docker' | 'disk' | 'offline';

/** The kind core gave an error it threw in this process, if any. */
export function kindOf(e: unknown): CoreErrorKind | undefined {
  return e instanceof Error && e.name === 'CodemmError' ? (e as Error & { kind?: CoreErrorKind }).kind : undefined;
}

/** This computer's problem behind an error thrown in this process: core's kind, or a write that ran out of space. */
export function infraOf(e: unknown): Infra | null {
  const kind = kindOf(e);
  if (kind === 'docker' || kind === 'disk' || kind === 'offline') return kind;
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC' ? 'disk' : null;
}

/**
 * The same, read from text: only for core's messages an agent relays back over MCP (a tool result), which carry
 * no kind. src/sandbox.ts, src/judge.ts and src/store.ts write them.
 */
export function infra(message: string): Infra | null {
  if (/not enough disk space|ran out of disk space|no space left on device/i.test(message)) return 'disk';
  if (/couldn't reach the network|could not resolve host|network is unreachable/i.test(message)) return 'offline';
  // A build that can't run Docker's credential helper is this computer's Docker problem, not the track's.
  if (/container runtime|Windows containers|Cannot connect to the Docker daemon|error getting credentials|container couldn't be removed|Couldn't list Codemm's containers|container couldn't start/i.test(message)) return 'docker';
  return null;
}

/** A failure no agent caused: this computer's problems, or a track image that needs a rebuild. A job spends no retry on it (§6.1). */
export function spendsNoRetry(message: string): boolean {
  return infra(message) !== null || /image for .* is missing or changed/i.test(message);
}
