// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus Check this computer's runtime reading and sandbox check, the
// workspace read, the job briefs, and doctor --fix's leftover-container rule for
// after a cancel or crash.
import { removeAbandoned } from '../../src/sandbox';

export * from '../../src/app';
export { networkIsolation } from '../../src/doctor';
export { RUNTIME_INFO, runtimeStateOf } from '../../src/sandbox';
export { readWorkspace } from '../../src/store';
export { JOB_BRIEFS } from '../../src/templates';

/** Removes only containers whose owning Codemm process is gone. */
export async function cleanupLeftovers(): Promise<void> {
  await removeAbandoned();
}
