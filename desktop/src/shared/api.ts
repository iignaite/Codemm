// The one seam between the UI and Codemm. The renderer only ever sees these
// types; the main process implements them (a mock today, the core later).
// Nothing here may carry solutions, hidden inputs, expected hidden output or
// hidden test names: hidden results are an index and a status only.

export type AgentState = 'connected' | 'not-connected' | 'failed';

export interface Agent {
  id: string;
  name: string;
  state: AgentState;
  /** What to do when `state` is `failed`. */
  fix?: string;
}

export interface Suggestions {
  /** Things the learner may already know, offered on the goal screen. */
  known: string[];
  /** Things to learn next, offered on the tracks screen. */
  next: string[];
}

export interface Goal {
  topic: string;
  known: string[];
}

export interface Source {
  name: string;
  read: boolean;
}

export interface PathStep {
  title: string;
  /** Why the step is quick, such as something the learner already knows. */
  because?: string;
}

export interface Research {
  title: string;
  track: string;
  /** Whether the track is already set up on this computer. */
  installed: boolean;
  sources: Source[];
  path: PathStep[];
  done: boolean;
}

export interface Draft {
  title: string;
  track: string;
  installed: boolean;
  topics: string[];
}

export type SetupState = 'running' | 'ready' | 'failed';
export type TopicState = 'mastered' | 'now' | 'later';
export type LessonState = 'writing' | 'ready' | 'read';
export type ActivityState = 'writing' | 'locked' | 'open' | 'passed';

export interface LessonRef {
  id: string;
  title: string;
  state: LessonState;
}

export interface ActivityRef {
  id: string;
  title: string;
  state: ActivityState;
}

export interface Topic {
  id: string;
  title: string;
  state: TopicState;
  /** 0 to 1. */
  mastery: number;
  lessons: LessonRef[];
  activity: ActivityRef;
  activitiesLeft: number;
}

export interface Course {
  title: string;
  track: string;
  setup: SetupState;
  topics: Topic[];
  review?: { topic: string; activityId: string };
}

export interface Predict {
  question: string;
  choices: string[];
  /** What actually happens, shown once the learner has chosen. */
  shows: string;
}

export interface Lesson {
  id: string;
  topicId: string;
  title: string;
  summary: string;
  code?: string;
  predict?: Predict;
  note: string;
}

export interface CodeFile {
  path: string;
  text: string;
}

export interface Activity {
  id: string;
  topicId: string;
  title: string;
  prompt: string;
  /** What a correct program shows, as an example for the learner. */
  example?: string;
  files: CodeFile[];
  assist: boolean;
}

export interface Message {
  from: 'you' | 'codemm';
  text: string;
  /** A line in the open file this message is about. */
  line?: number;
  /** Codemm declined because practice mode is on. */
  locked?: boolean;
}

export type TestStatus = 'pass' | 'fail' | 'error';

export interface VisibleTest {
  name: string;
  status: TestStatus;
  expected?: string;
  found?: string;
}

export type CheckResult =
  | {
      kind: 'graded';
      passed: number;
      total: number;
      visible: VisibleTest[];
      hidden: TestStatus[];
      stuck: boolean;
      /** Progress in words, shown after a pass. */
      progress?: string;
    }
  | { kind: 'not-counted'; reason: string };

export interface RunResult {
  output: string;
}

export interface Track {
  id: string;
  name: string;
}

export type Place = { lessonId: string } | { activityId: string };

export interface CodemmApi {
  agents(): Promise<Agent[]>;
  connect(agentId: string): Promise<Agent>;
  suggestions(): Promise<Suggestions>;

  /** Starts research on the first call; call again to follow it. */
  research(goal: Goal): Promise<Research>;
  revise(draft: Draft, request: string): Promise<Draft>;
  /** Saves the course and, if its track isn't installed, starts setting it up. */
  approve(draft: Draft): Promise<Course>;
  /** Retries a failed setup. */
  setUp(): Promise<void>;

  course(): Promise<Course | null>;
  lesson(id: string): Promise<Lesson>;
  read(lessonId: string): Promise<void>;
  saveNote(lessonId: string, note: string): Promise<void>;

  activity(id: string): Promise<Activity>;
  run(activityId: string, files: CodeFile[]): Promise<RunResult>;
  check(activityId: string, files: CodeFile[]): Promise<CheckResult>;
  /** `hint` nudges; `show` points at the line to look at. */
  help(activityId: string, kind: 'hint' | 'show'): Promise<Message>;
  /** Codemm's replies to the learner's question. */
  ask(place: Place, text: string): Promise<Message[]>;
  /** Turns assist on (Codemm edits the activity, and it counts for less) or off. */
  assist(activityId: string, on: boolean): Promise<Activity>;
  easier(activityId: string): Promise<string>;

  tracks(): Promise<Track[]>;
  rebuild(trackId: string): Promise<void>;
}

/** What the preload script exposes as `window.codemm`. */
export interface Bridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
}
