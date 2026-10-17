// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus the doctor, the store reads the boundary needs,
// the job briefs, and doctor --fix's leftover-container rule for after a cancel or crash.
import { cli, ownedContainers, ownerGone } from '../../src/sandbox';

export * from '../../src/app';
export { doctor } from '../../src/doctor';
export { readExercise, readWorkspace } from '../../src/store';
export { JOB_BRIEFS } from '../../src/templates';

/** Removes only containers whose owning Codemm process is gone. */
export async function cleanupLeftovers(): Promise<void> {
  const abandoned = (await ownedContainers()).filter((c) => ownerGone(c.pid));
  if (abandoned.length) await cli(['rm', '-f', ...abandoned.map((c) => c.id)]);
}
