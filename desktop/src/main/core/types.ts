// The core `app` functions the desktop calls in-process (DESIGN §2), with the
// shapes it relies on. coreApp.test.ts checks the bundled core against them.

export type TestStatus = 'pass' | 'fail' | 'error';

/** core app.ts CheckView: visible results in full, hidden ones named `hidden #n` with a status only. */
export interface CoreCheckView {
  exercise: string;
  passed: number;
  total: number;
  tests: { name: string; status: TestStatus; message?: string; actual?: string }[];
  recorded: boolean;
  note?: string;
}

export interface CoreExercise {
  course: string;
  exercise: string;
  /** An absolute path: never shown (D15). */
  path: string;
  style: 'io' | 'unit';
  concepts: string[];
  difficulty: number;
  files: string[];
  statement: string;
  hint?: string;
  visibleTests: { name: string; input?: string; expected?: string }[];
}

export interface CoreRoadmap {
  course: string;
  goal: string;
  track: string;
  style: string;
  concepts: { id: string; title: string; requires: string[] }[];
}

export type CoreNextStep =
  | { kind: 'practice'; exercise: string; concept: string; lesson?: string | null }
  | { kind: 'author'; concept: string; difficulty: number; lesson?: string | null }
  | { kind: 'setup'; track: string }
  | { kind: 'stuck'; concept: string }
  | { kind: 'done' };

export interface CoreProgress {
  course: string;
  goal: string;
  track: string;
  concepts: { id: string; title: string; requires: string[]; mastery: number; mastered: boolean; attempts: number; stuck: boolean }[];
  next: CoreNextStep;
}

export interface CoreLesson {
  id: string;
  concept: string;
  title: string;
  markdown: string;
  notes: string;
}

export interface CoreApp {
  /** core templates.ts: one brief per agent job, the same text the terminal uses. */
  JOB_BRIEFS: Record<'research' | 'roadmap' | 'setup' | 'lesson' | 'author' | 'tutor', string>;
  doctor(fix: boolean): Promise<{ name: string; ok: boolean; detail: string }[]>;
  readWorkspace(ws: string): { course?: string; current?: string };
  readExercise(course: string, slug: string): { record: { expected?: Record<string, string> }; files: Record<string, string> };
  /** `track` is `id@version`. */
  listTracks(): { track: string; styles: string[]; files: string[] }[];
  rebuildTrack(ref: string): Promise<unknown>;
  saveRoadmap(ws: string, course: string, yaml: string, bound?: string): Promise<{ course: string }>;
  progress(ws: string, bound?: string): CoreProgress;
  /** Containers whose owning Codemm process is gone are removed (doctor --fix's rule). Added by scripts/core-entry.ts. */
  cleanupLeftovers(): Promise<void>;
  getExercise(ws: string, slug?: string, bound?: string): Promise<CoreExercise>;
  testExercise(ws: string, slug?: string, bound?: string): Promise<CoreCheckView>;
  checkExercise(ws: string, slug?: string, bound?: string): Promise<CoreCheckView>;
  skip(ws: string, concept: string, bound?: string): Promise<void>;
  assertRuntime(): Promise<void>;
  getRoadmap(ws: string, bound?: string): CoreRoadmap;
  listProposals(): { track: string; digest: string; created: string; files: Record<string, string> }[];
  installProposal(ref: string, digest: string): Promise<unknown>;
  dropProposal(ref: string): Promise<void>;
  getLesson(ws: string, id: string, bound?: string): CoreLesson;
  listLessons(ws: string, bound?: string): { id: string; concept: string; title: string; read: boolean }[];
  listExercises(ws: string, bound?: string): { exercise: string; concepts: string[]; difficulty: number; created: string }[];
  saveNotes(ws: string, id: string, text: string, bound?: string): Promise<void>;
  markLessonRead(ws: string, id: string, bound?: string): Promise<void>;
  readLearnerFiles(ws: string, slug: string, bound?: string): Record<string, { text: string; digest: string }>;
  writeLearnerFile(ws: string, slug: string, path: string, text: string, digest: string, bound?: string): Promise<{ digest: string }>;
}
