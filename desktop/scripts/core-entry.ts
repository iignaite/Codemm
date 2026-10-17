// What the desktop main process loads from the core, in-process (DESIGN §2):
// the `app` use cases, plus the doctor and the store reads the boundary needs.
export * from '../../src/app';
export { doctor } from '../../src/doctor';
export { readExercise, readWorkspace } from '../../src/store';
