// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus Check this computer's runtime reading and sandbox check, the
// workspace read, the job briefs, and doctor --fix's leftover-container rule for
// after a cancel or crash.
import { infraError } from '../../src/errors';
import { removeAbandoned, runtimeState } from '../../src/sandbox';

export * from '../../src/app';
export { networkIsolation } from '../../src/doctor';
export { RUNTIME_INFO, runtimeState } from '../../src/sandbox';
export { readWorkspace } from '../../src/store';
export { JOB_BRIEFS } from '../../src/templates';

/**
 * Removes only containers whose owning Codemm process is gone, and fails if any of them is still there. A runtime
 * that is missing, down or on Windows containers runs none of Codemm's, so that's no failure; any other failure (a
 * timeout under load, a busy runtime) is one.
 */
export async function cleanupLeftovers(): Promise<void> {
  const { left } = await removeAbandoned().catch(async (e: unknown) => {
    const state = await runtimeState().catch(() => undefined);
    if (state === 'missing' || state === 'down' || state === 'windows') return { left: 0 };
    throw e;
  });
  if (left > 0) throw infraError(`${left} abandoned container${left === 1 ? '' : 's'} couldn't be removed.`, 'container-remove');
}
