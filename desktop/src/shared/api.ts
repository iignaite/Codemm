// The IPC contract (docs/desktop/DESIGN.md §2, D3): every call the renderer can
// make, and the learner-safe views it gets back. Main validates each call's
// input (src/main/ipc.ts) and answers with one function. Nothing here may
// carry a solution, mutant, hidden test, expected hidden output, author
// transcript, tool argument or agent stderr (§2.2, D4).

// ---------- errors ----------

/**
 * A failed call rejects with an Error whose message holds one of these codes.
 * None of them records anything.
 */
export const SIGNED_OUT = 'codemm:signed-out';
export const NO_AGENT = 'codemm:no-agent';
export const PLAN_LIMIT = 'codemm:plan-limit';
/** An agent job failed or wasn't done by its check (§5). */
export const AGENT_FAILED = 'codemm:agent-failed';
/** A damaged Codemm record. The message's next lines are core's repair guidance (§5). */
export const REPAIR = 'codemm:repair';
/** A cancel the agent's process group survived: "Codemm couldn't stop your agent" (§3.1). */
export const UNSTOPPABLE = 'codemm:unstoppable';
/** A learner file changed outside Codemm since the editor loaded it (§4.5). */
export const CHANGED = 'codemm:changed';

// ---------- connect (§3.1, §3.3) ----------

export type AgentId = 'claude' | 'codex' | 'cursor';

/** `missing`: not installed. `signed-out`: installed, but its sign-in check failed. */
export type AgentState = 'connected' | 'not-connected' | 'missing' | 'signed-out';

/** A bench-tested model the learner may choose for an agent (O6). */
export interface ModelChoice {
  /** What the agent's CLI takes: `--model` for Claude Code, `-m` for Codex. */
  id: string;
  label: string;
  recommended: boolean;
}

export interface Agent {
  id: AgentId;
  name: string;
  state: AgentState;
  installUrl: string;
  /** The bench-tested models, from models.json; empty for an agent with no choice. */
  models: ModelChoice[];
  /** The model every job for this agent runs: the learner's choice, or the recommended one. */
  model: string | null;
  /** The installed CLI version isn't one Codemm was tested with. It may still work. */
  untested: boolean;
  experimental: boolean;
}

// ---------- check this computer (§6.1) ----------

export type Platform = 'mac' | 'windows' | 'linux';
export type CheckId = 'docker-installed' | 'docker-running' | 'sandbox';

export interface ComputerCheck {
  id: CheckId;
  /** `waiting`: an earlier check has to pass first. */
  state: 'ok' | 'problem' | 'waiting';
  /** For a running problem: Docker is still starting, or set to Windows containers. */
  detail?: 'starting' | 'windows-containers';
}

export interface Computer {
  platform: Platform;
  checks: ComputerCheck[];
  ready: boolean;
}

// ---------- roadmap (§4.2) ----------

export interface Goal {
  topic: string;
  /** What the learner says they already know, in their words. */
  known: string;
}

export interface Concept {
  id: string;
  title: string;
  requires: string[];
}

export interface Roadmap {
  goal: string;
  /** The track's display name, from list_tracks or the agent's proposal. */
  track: string;
  installed: boolean;
  concepts: Concept[];
  /** The roadmaps and docs the agent used. Opened only in the system browser (§2.1). */
  sources: { title: string; url: string }[];
}

export type JobState = 'running' | 'done' | 'failed';

/** The research job writes the roadmap; poll until it's done. */
export interface Research {
  state: JobState;
  roadmap?: Roadmap;
}

export interface RoadmapChange {
  roadmap: Roadmap;
  changed: boolean;
  /** The agent's reply, shown when nothing changed. */
  text: string;
}

// ---------- course (§3.2, §4.1, §4.3, §4.4) ----------

/**
 * `proposing`: the setup job is writing a proposal. `consent`: waiting for the
 * learner. `installing`: building the approved proposal.
 */
export type SetupState = 'proposing' | 'consent' | 'installing' | 'ready' | 'failed';
/** Why setup failed. `offline`, `disk` and `docker` are this computer's problems; `gates` means the proposals didn't pass. */
export type SetupProblem = 'offline' | 'disk' | 'docker' | 'gates';

/** What the learner approves before setup: exactly the files Codemm will build (§4.1). */
export interface Proposal {
  digest: string;
  /** True when an earlier proposal failed its gates: "Codemm has another way". */
  retry: boolean;
  files: { path: string; text: string }[];
}

export type TopicState = 'mastered' | 'now' | 'later';
export type LessonState = 'writing' | 'ready' | 'read';
export type ActivityState = 'writing' | 'locked' | 'open' | 'passed';

export interface TopicView {
  id: string;
  title: string;
  state: TopicState;
  /** 0 to 1. */
  mastery: number;
  stuck: boolean;
  lessons: { id: string; title: string; state: LessonState }[];
  activity: ActivityState;
}

export interface CourseView {
  goal: string;
  track: string;
  setup: SetupState;
  setupProblem?: SetupProblem;
  proposal?: Proposal;
  topics: TopicView[];
  done: boolean;
  /** Background work (setup, lessons, activities) stopped after its retry, and why (§5). Nothing was recorded. */
  stalled?: 'plan-limit' | 'signed-out' | 'failed' | 'unstoppable';
}

export interface Lesson {
  id: string;
  concept: string;
  title: string;
  /** Static Markdown, rendered with raw HTML stripped (§2.1). */
  markdown: string;
  notes: string;
}

// ---------- activity (§4.5, D11) ----------

export interface LearnerFile {
  path: string;
  text: string;
  digest: string;
}

export interface VisibleTest {
  name: string;
  input?: string;
  expected?: string;
}

export interface Activity {
  id: string;
  concept: string;
  title: string;
  /** Markdown. */
  statement: string;
  visibleTests: VisibleTest[];
  files: LearnerFile[];
}

export type TestStatus = 'pass' | 'fail' | 'error';

/** One test result. A hidden test has no name or detail: an index and a status only. */
export type TestView =
  | { hidden: false; name: string; status: TestStatus; message?: string; actual?: string }
  | { hidden: true; index: number; status: TestStatus };

export type CheckResult =
  | {
      kind: 'graded';
      passed: number;
      total: number;
      tests: TestView[];
      /** False for a check of the unedited starter (core §7). */
      recorded: boolean;
      stuck: boolean;
      mastered: boolean;
    }
  /** An infrastructure failure: nothing was recorded. */
  | { kind: 'not-counted'; reason: string };

/** Try it: visible tests only, never recorded. */
export type TryResult = { kind: 'ran'; passed: number; total: number; tests: TestView[] } | { kind: 'not-counted'; reason: string };

export type Place = { lessonId: string } | { activityId: string };

export interface Message {
  from: 'you' | 'codemm';
  text: string;
}

export interface Track {
  ref: string;
  name: string;
}

export interface CodemmApi {
  agents(): Promise<Agent[]>;
  /** Chooses the agent and runs its sign-in check. */
  connect(agent: AgentId): Promise<Agent>;
  /** Chooses the model for an agent's jobs, one of its `models`. */
  chooseModel(agent: AgentId, model: string): Promise<Agent>;
  computer(): Promise<Computer>;
  tracks(): Promise<Track[]>;

  /** Starts the research job on the first call; call again to follow it. */
  research(goal: Goal): Promise<Research>;
  /** Saves the learner's edits, then runs a roadmap-change job. */
  reviseRoadmap(concepts: Concept[], request: string): Promise<RoadmapChange>;
  /** Saves the roadmap. If its track isn't installed, starts the setup job. */
  approve(concepts: Concept[]): Promise<void>;

  course(): Promise<CourseView | null>;
  /** Builds the proposal the learner saw. Also retries after an offline or low-disk failure. */
  install(digest: string): Promise<void>;
  /** Runs the setup job again, after its proposals failed their gates. */
  retrySetup(): Promise<void>;
  /** Starts stalled background work again. */
  retryJobs(): Promise<void>;

  lesson(id: string): Promise<Lesson>;
  saveNotes(lessonId: string, notes: string): Promise<void>;
  markRead(lessonId: string): Promise<void>;

  /** The current activity for a concept. */
  activity(concept: string): Promise<Activity>;
  /** Saves one learner file. Rejects with CHANGED if it changed since `digest`. Returns the new digest. */
  saveFile(activityId: string, path: string, text: string, digest: string): Promise<string>;
  tryIt(activityId: string): Promise<TryResult>;
  check(activityId: string): Promise<CheckResult>;

  /** A tutor turn. A reply that shows hidden material is held back (§2.2). */
  ask(place: Place, text: string): Promise<Message[]>;
  /** "Come back later": defers the concept without changing mastery (§4.4). */
  skip(concept: string): Promise<void>;
  /** "Try an easier one": a roadmap-change job that adds a prerequisite topic (§3.2). */
  easier(concept: string): Promise<void>;

  rebuild(trackRef: string): Promise<void>;
}

/** What the preload script exposes as `window.codemm`. */
export interface Bridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
}
