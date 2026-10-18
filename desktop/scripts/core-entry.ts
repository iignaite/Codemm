// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus Check this computer's runtime reading and sandbox check, the
// workspace read, the job briefs, and doctor --fix's leftover-container rule for
// after a cancel or crash.
import { removeAbandoned, runtimeDown } from '../../src/sandbox';

export * from '../../src/app';
export { networkIsolation } from '../../src/doctor';
export { RUNTIME_INFO, runtimeStateOf } from '../../src/sandbox';
export { readWorkspace } from '../../src/store';
export { JOB_BRIEFS } from '../../src/templates';

/**
 * Removes only containers whose owning Codemm process is gone, and fails if any of them is still there. A runtime
 * that is down runs no containers, so that's no failure; any other failure (a timeout under load) is one.
 */
export async function cleanupLeftovers(): Promise<void> {
  const { left } = await removeAbandoned().catch(async (e: unknown) => {
    if (await runtimeDown().catch(() => undefined)) return { left: 0 };
    throw e;
  });
  if (left > 0) throw new Error(`${left} abandoned container${left === 1 ? '' : 's'} couldn't be removed.`);
}
