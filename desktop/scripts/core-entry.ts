// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus Check this computer's runtime reading and sandbox check, the
// workspace read, the job briefs, and doctor --fix's leftover-container rule for
// after a cancel or crash.
import { infraError } from '../../src/errors';
import { removeAbandoned } from '../../src/sandbox';

export * from '../../src/app';
export { networkIsolation } from '../../src/doctor';
export { RUNTIME_INFO, runtimeState } from '../../src/sandbox';
export { readWorkspace } from '../../src/store';
export { JOB_BRIEFS } from '../../src/templates';

/** A runtime that runs none of Codemm's containers: missing, not running, or on Windows containers. */
const NONE_RUNNING = new Set(['no-runtime', 'runtime-down', 'runtime-paused', 'socket-permission', 'runtime-context', 'windows-containers']);

/**
 * Removes only containers whose owning Codemm process is gone, and fails if any of them is still there. Listing them
 * already asked the runtime when it failed, so its code says whether it runs none (no failure); any other failure (a
 * timeout under load, a busy runtime) is one.
 */
export async function cleanupLeftovers(): Promise<void> {
  const { left } = await removeAbandoned().catch((e: unknown) => {
    if (NONE_RUNNING.has(String((e as { code?: unknown }).code))) return { left: 0 };
    throw e;
  });
  if (left > 0) throw infraError(`${left} abandoned container${left === 1 ? '' : 's'} couldn't be removed.`, 'container-remove');
}
