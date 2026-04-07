import db from "./database/db";

export { initializeDatabase } from "./database/migrations";
export type {
  DBActivity,
  DBActivitySummary,
  Submission,
} from "./database/repositories/activityRepository";
export {
  activityRepository as activityDb,
  submissionRepository as submissionDb,
} from "./database/repositories/activityRepository";
export type {
  DBGenerationExecutionAttempt,
  DBGenerationRunFailureCacheEntry,
  DBGenerationRun,
  DBGenerationSlotRun,
  DBGenerationSlotDiagnosis,
  DBGenerationSlotTransition,
} from "./database/repositories/generationRunRepository";
export {
  generationExecutionAttemptRepository as generationExecutionAttemptDb,
  generationRunFailureCacheRepository as generationRunFailureCacheDb,
  generationRunRepository as generationRunDb,
  generationSlotRunRepository as generationSlotRunDb,
  generationSlotDiagnosisRepository as generationSlotDiagnosisDb,
  generationSlotTransitionRepository as generationSlotTransitionDb,
} from "./database/repositories/generationRunRepository";
export type {
  DBSession,
  DBSessionCollector,
  DBSessionMessage,
  DBSessionSummary,
} from "./database/repositories/threadRepository";
export {
  threadCollectorRepository as threadCollectorDb,
  threadMessageRepository as threadMessageDb,
  threadRepository as threadDb,
} from "./database/repositories/threadRepository";
export type {
  RunEventRecord,
  RunKind,
  RunRecord,
  RunStatus,
} from "./database/repositories/runRepository";
export {
  runEventRepository as runEventDb,
  runRepository as runDb,
} from "./database/repositories/runRepository";

export interface DBLearnerProfile {
  // removed (SaaS/user-account concept)
}

export const userDb = undefined as never;
export const learnerProfileDb = undefined as never;

export default db;
