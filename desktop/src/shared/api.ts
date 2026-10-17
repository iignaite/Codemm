// The only contract between the renderer and Codemm. Everything here is
// learner-safe: no solutions, hidden inputs, expected hidden outputs or test names.

export type AgentState = 'available' | 'connected' | 'failed';
export interface Agent {
  id: string;
  name: string;
  state: AgentState;
  problem?: string;
}

export interface Suggestions {
  learn: string[];
  known: string[];
}

export interface Track {
  id: string;
  name: string;
}

export interface Goal {
  topic: string;
  known: string[];
}

export interface DraftTopic {
  id: string;
  title: string;
  known?: string;
}

export interface Draft {
  title: string;
  track: string;
  needsSetup: boolean;
  topics: DraftTopic[];
}

export interface Research {
  sources: string[];
  draft: Draft;
}

export type SetupState = 'running' | 'ready' | 'retrying' | 'failed';
export type TopicState = 'mastered' | 'now' | 'later';
export type LessonState = 'writing' | 'ready' | 'read';

export interface LessonRef {
  id: string;
  title: string;
  state: LessonState;
}

export interface Topic {
  id: string;
  title: string;
  state: TopicState;
  mastery: number;
  lessons: LessonRef[];
  /** Exercise id, once the activity has passed its gates. */
  activity?: string;
}

export interface CourseSummary {
  id: string;
  title: string;
}

export interface Course extends CourseSummary {
  track: string;
  setup: SetupState;
  topics: Topic[];
  /** Topic id due for review. */
  review?: string;
}

export interface Predict {
  question: string;
  options: string[];
  answer: number;
  shown: string;
}

export interface Lesson {
  id: string;
  topicId: string;
  title: string;
  body: string;
  code?: string;
  predict?: Predict;
  note: string;
}

export interface LessonEdit {
  body: string;
  note: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface Exercise {
  id: string;
  topicId: string;
  title: string;
  statement: string;
  example?: string;
  files: SourceFile[];
  assist: boolean;
}

export interface VisibleTest {
  name: string;
  passed: boolean;
  expected?: string;
  found?: string;
}

/** Hidden results carry an index (their position) and a status only. */
export type HiddenStatus = 'passed' | 'failed';

export interface Note {
  from: 'codemm' | 'you';
  text: string;
  line?: number;
  lock?: boolean;
}

export interface Tested {
  kind: 'tested';
  visible: VisibleTest[];
}

export interface Graded {
  kind: 'graded';
  passed: number;
  total: number;
  visible: VisibleTest[];
  hidden: HiddenStatus[];
  recorded: boolean;
  mastered: boolean;
  stuck: boolean;
  note?: Note;
}

/** The sandbox couldn't run. Nothing was recorded. */
export interface Infra {
  kind: 'infra';
  problem: string;
}

export type Where = { lesson: string } | { exercise: string };

export interface CodemmApi {
  listAgents(): Promise<Agent[]>;
  connectAgent(id: string): Promise<Agent>;
  suggestions(): Promise<Suggestions>;
  listTracks(): Promise<Track[]>;
  rebuildTrack(id: string): Promise<void>;
  research(goal: Goal): Promise<Research>;
  reviseDraft(draft: Draft, request: string): Promise<Draft>;
  /** Saves the course and, when needed, starts setting up its track. */
  approveDraft(draft: Draft): Promise<Course>;
  setUpTrack(courseId: string): Promise<void>;
  listCourses(): Promise<CourseSummary[]>;
  getCourse(id: string): Promise<Course>;
  /** Returns the lesson and marks it read. */
  openLesson(id: string): Promise<Lesson>;
  saveLesson(id: string, edit: LessonEdit): Promise<Lesson>;
  getExercise(id: string): Promise<Exercise>;
  /** Keeps the learner's draft. Not graded, not recorded. */
  saveFiles(exerciseId: string, files: SourceFile[]): Promise<void>;
  /** Visible tests only. Not graded, not recorded. */
  test(exerciseId: string, files: SourceFile[]): Promise<Tested | Infra>;
  check(exerciseId: string, files: SourceFile[]): Promise<Graded | Infra>;
  hint(exerciseId: string): Promise<Note>;
  ask(where: Where, text: string): Promise<Note[]>;
  setAssist(on: boolean): Promise<void>;
  /** Fires whenever anything above may have changed. Returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export type ApiMethod = Exclude<keyof CodemmApi, 'onChange'>;

export const API_METHODS = [
  'listAgents', 'connectAgent', 'suggestions', 'listTracks', 'rebuildTrack',
  'research', 'reviseDraft', 'approveDraft', 'setUpTrack', 'listCourses', 'getCourse',
  'openLesson', 'saveLesson', 'getExercise', 'saveFiles', 'test', 'check', 'hint', 'ask', 'setAssist',
] as const satisfies readonly ApiMethod[];

export const CHANGED_CHANNEL = 'codemm:changed';
export const channel = (method: ApiMethod): string => `codemm:${method}`;
