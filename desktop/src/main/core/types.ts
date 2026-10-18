import type { CheckProgress } from '../../shared/api';
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
  /** The track's run command, for io exercises. */
  run?: string;
}

export interface CoreRoadmap {
  course: string;
  goal: string;
  track: string;
  style: string;
  concepts: { id: string; title: string; requires: string[] }[];
  /** The roadmaps and docs the research job used (core §5): https links only. */
  sources?: { title: string; url: string }[];
}

export type CoreNextStep =
  | { kind: 'practice'; exercise: string; concept: string; lesson?: string | null }
  | { kind: 'author'; concept: string; difficulty: number; lesson?: string | null; review?: true }
  | { kind: 'review'; concept: string; difficulty: number; exercise: string }
  | { kind: 'setup'; track: string }
  | { kind: 'stuck'; concept: string }
  | { kind: 'done' };

export interface CoreProgress {
  course: string;
  goal: string;
  track: string;
  /** `reviewDue`: when a mastered concept's next review is due (core §7). */
  concepts: { id: string; title: string; requires: string[]; mastery: number; mastered: boolean; attempts: number; stuck: boolean; reviewDue?: string }[];
  next: CoreNextStep;
}

export interface CoreLesson {
  id: string;
  concept: string;
  title: string;
  markdown: string;
  notes: string;
  /** Runnable examples: file maps that follow the track's contract. */
  examples: Record<string, string>[];
}

/** core judge.ts ProgramRun: a running program. `write` is false when the input wasn't taken. */
export interface CoreProgramRun {
  write(text: string): boolean;
  kill(): void;
  done: Promise<{ exit: number; stage?: 'build' | 'run'; timedOut: boolean; flooded: boolean; stopped?: boolean; outOfMemory?: boolean }>;
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
  testExercise(ws: string, slug?: string, bound?: string, onProgress?: (p: CheckProgress) => void): Promise<CoreCheckView>;
  checkExercise(ws: string, slug?: string, bound?: string, onProgress?: (p: CheckProgress) => void): Promise<CoreCheckView>;
  skip(ws: string, concept: string, bound?: string): Promise<void>;
  assertRuntime(): Promise<void>;
  getRoadmap(ws: string, bound?: string): CoreRoadmap;
  listProposals(): { track: string; digest: string; created: string; files: Record<string, string> }[];
  /** `onProgress` hears each build step as counts, then the probes: never the build's output (core §4.4). */
  installProposal(ref: string, digest: string, onProgress?: (p: { phase: 'building'; done: number; total: number } | { phase: 'checking' }) => void): Promise<unknown>;
  dropProposal(ref: string): Promise<void>;
  getLesson(ws: string, id: string, bound?: string): CoreLesson;
  /**
   * Run: the current exercise's program with typed input, streamed, time-limited, never recorded. io tracks only.
   * `done` rejects only on an infrastructure failure.
   */
  runInteractive(ws: string, slug: string | undefined, bound: string | undefined, output: (text: string, stream: 'stdout' | 'stderr') => void, options?: { onStart?: (stage: 'build' | 'run', limitMs: number) => void }): Promise<CoreProgramRun>;
  /** Runs a saved lesson example in the sandbox; output and errors are capped. Never recorded. */
  runExample(ws: string, lessonId: string, index: number, bound?: string): Promise<{ exit: number; output: string; errors: string }>;
  listLessons(ws: string, bound?: string): { id: string; concept: string; title: string; read: boolean }[];
  listExercises(ws: string, bound?: string): { exercise: string; concepts: string[]; difficulty: number; created: string }[];
  saveNotes(ws: string, id: string, text: string, bound?: string): Promise<void>;
  markLessonRead(ws: string, id: string, bound?: string): Promise<void>;
  readLearnerFiles(ws: string, slug: string, bound?: string): Record<string, { text: string; digest: string }>;
  writeLearnerFile(ws: string, slug: string, path: string, text: string, digest: string, bound?: string): Promise<{ digest: string }>;
}
