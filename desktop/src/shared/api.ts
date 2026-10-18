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
/** This computer couldn't reach the network: the agent's service, or a build's downloads. */
export const OFFLINE = 'codemm:offline';
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

/**
 * Codemm installing Docker Desktop for the learner (§6.1). `starting`: installed and opened; Docker's own window
 * asks the learner to accept its terms. Problems: `offline` and `disk` are this computer's; `unverified`: the
 * download wasn't signed by Docker, so it was deleted; `manual`: drag Docker to Applications in the window that
 * opened; `restart`: Windows needs a restart; `failed`: Docker's installer didn't finish.
 */
export interface DockerInstall {
  phase: 'downloading' | 'checking' | 'installing' | 'starting' | 'failed';
  /** 0 to 1 while downloading. */
  progress?: number;
  problem?: 'offline' | 'disk' | 'unverified' | 'manual' | 'restart' | 'failed';
}

export interface Computer {
  platform: Platform;
  checks: ComputerCheck[];
  ready: boolean;
  /** Codemm can install and open Docker Desktop here (macOS and Windows). */
  canInstall?: boolean;
  /** An install Codemm started, while it runs and after it fails. */
  install?: DockerInstall;
}

// ---------- roadmap (§4.2) ----------

/** How deep the roadmap goes, as the learner chose: about 8, 15 or 25 to 30 single-skill topics. */
export type Depth = 'overview' | 'standard' | 'in-depth';

export interface Goal {
  topic: string;
  /** What the learner says they already know, in their words. */
  known: string;
  depth: Depth;
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
  /** A mastered topic due for review: its review activity is open, or being written. */
  review?: 'due' | 'writing';
  /** Whole days until a mastered topic's next review, when one is scheduled and not yet due. */
  reviewIn?: number;
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
  stalled?: 'plan-limit' | 'signed-out' | 'offline' | 'failed' | 'unstoppable';
}

export interface Lesson {
  id: string;
  concept: string;
  title: string;
  /** Static Markdown, rendered with raw HTML stripped (§2.1). It places example N as a fenced block `example` holding N. */
  markdown: string;
  notes: string;
  /** Runnable examples, in order: each runs in the sandbox on request and is never recorded (§4.3). */
  examples: { files: { path: string; text: string }[] }[];
}

/** One run of a lesson example (output capped by core), or why it didn't run (Docker, §6.1). */
export type ExampleRun = { kind: 'ran'; exit: number; output: string; errors: string } | { kind: 'not-run'; reason: string };

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
  /** The track's run command, for io activities only: they have Run. */
  run?: string;
}

/** What Run's program printed, or a stage starting with its time limit, for the countdown. */
export type RunOutput = { run: string; stream: 'stdout' | 'stderr'; text: string } | { run: string; started: 'build' | 'run'; limitMs: number };

/**
 * How Run ended. Never recorded. `exit` is the program's own code. `stopped`: the learner stopped it.
 * `timedOut`: its time limit did. `flooded`: it printed too much. `not-run`: Codemm couldn't run it.
 */
export type RunResult =
  | { kind: 'ran'; exit: number; stage?: 'build' | 'run'; timedOut: boolean; stopped: boolean; flooded: boolean; outOfMemory: boolean }
  | { kind: 'not-run'; reason: string };

export type TestStatus = 'pass' | 'fail' | 'error';

/**
 * Progress through Try it or Check: a phase and counts. `total` 0 means not counted (hidden and unit tests).
 * A visible io test also arrives with its result as it finishes; nothing about a hidden test ever does.
 */
export interface CheckProgress {
  /** The run it belongs to: the id the renderer passed to tryIt or check. */
  run?: string;
  phase: 'building' | 'visible' | 'hidden';
  done: number;
  total: number;
  test?: FinishedTest;
}

/** A visible io test's result as it finishes: its name (`visible/01`), status, message and what the program printed. */
export interface FinishedTest {
  name: string;
  status: TestStatus;
  message?: string;
  actual?: string;
}

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
  /** Hears progress while Try it or Check runs; returns a function that stops listening. An event, not a call. */
  onCheckProgress(listener: (progress: CheckProgress) => void): () => void;
  /** Hears every agent job's progress while it runs; returns a function that stops listening. An event, not a call. */
  onJobProgress(listener: (progress: JobProgress) => void): () => void;
  /** The jobs running now, for a screen that opens while one runs; onJobProgress follows them. */
  jobProgress(): Promise<JobProgress[]>;
  /** Hears what Run's programs print; returns a function that stops listening. An event, not a call. */
  onRunOutput(listener: (output: RunOutput) => void): () => void;
  computer(): Promise<Computer>;
  /** Downloads Docker Desktop from Docker, checks Docker signed it, installs and opens it. Follow it with computer(). */
  installDocker(): Promise<void>;
  /** Opens Docker Desktop. */
  openDocker(): Promise<void>;
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
  /** `run` tags this run's progress events, so the renderer hears only its own. */
  tryIt(activityId: string, run?: string): Promise<TryResult>;
  /** Runs a lesson's example `index` (from 1) in the sandbox. Never recorded. */
  runExample(lessonId: string, index: number): Promise<ExampleRun>;
  check(activityId: string, run?: string): Promise<CheckResult>;
  /**
   * Run: the learner's program with typed input, time-limited, never recorded. Resolves when it ends; what it prints
   * arrives through onRunOutput, tagged with `run`, and only in the window that started it.
   */
  runProgram(activityId: string, run: string): Promise<RunResult>;
  /** Typed input for a Run this window started. False if it wasn't taken: the run ended, or too much is waiting. */
  sendRunInput(run: string, text: string): Promise<boolean>;
  /** Stops a Run this window started. */
  stopRun(run: string): Promise<void>;

  /** A tutor turn. A reply that shows hidden material is held back (§2.2). */
  ask(place: Place, text: string): Promise<Message[]>;
  /** "Come back later": defers the concept without changing mastery (§4.4). */
  skip(concept: string): Promise<void>;
  /** "Try an easier one": a roadmap-change job that adds a prerequisite topic (§3.2). */
  easier(concept: string): Promise<void>;

  rebuild(trackRef: string): Promise<void>;
}

/** One thing a job did: a web search, an https page (host and path) or one of Codemm's steps (§4.11). */
export type JobStep = { kind: 'search'; query: string } | { kind: 'read'; url: string } | { kind: 'step'; label: string };

/** The agent jobs (§3.2): research, a roadmap change, setup, a lesson, an activity (author) and a tutor turn. */
export type JobKind = 'research' | 'roadmap' | 'setup' | 'lesson' | 'author' | 'tutor';

/**
 * A running job's progress (§4.11): its stage (an index into JOB_STAGES[kind]), its latest steps and how long it has
 * run. Never a file path, a file's contents, a hidden test or anything else from Codemm's records.
 */
export interface JobProgress {
  /** This run of the job, an opaque id: a new run starts fresh. */
  job: string;
  kind: JobKind;
  /** The topic a lesson or author job writes for. */
  concept?: string;
  stage: number;
  /** The latest steps, newest first, at most 8. */
  steps: JobStep[];
  /** How many steps so far. */
  count: number;
  /** "Trying again": attempt 2 of 3 after a failed save, or 2 of 2 after a relaunch. */
  retry?: { attempt: number; of: number };
  /** False while one of Codemm's own tools runs: then the agent is waiting, not thinking. */
  thinking: boolean;
  /** Since the job started, and since its last event, when this was sent. */
  elapsedMs: number;
  idleMs: number;
  /** The job ended: screens stop showing it. */
  ended?: true;
}

/** What the preload script exposes as `window.codemm`. */
export interface Bridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  /** Events main sends, to the app window only: check progress, job progress, and Run's output (to the window that started it). */
  onCheckProgress(listener: (progress: CheckProgress) => void): () => void;
  onJobProgress(listener: (progress: JobProgress) => void): () => void;
  onRunOutput(listener: (output: RunOutput) => void): () => void;
}
