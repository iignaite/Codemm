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
/** Why a check wasn't counted when a track's image is missing or changed: the fix is under Tracks, not this computer (§5). */
export const REBUILD = 'This environment needs a rebuild. Rebuild it under Tracks.';
/** Why a run wasn't counted, or didn't run, when this computer caused it (notCounted.ts). */
export const NOT_COUNTED = {
  docker: "Docker isn't running.",
  'docker-busy': 'Docker is busy or not answering.',
  'docker-failed': "Docker couldn't run that.",
  'docker-disk': 'Docker ran out of disk space.',
  disk: 'This computer is out of disk space.',
  offline: "Docker couldn't reach the network.",
  // A WASI track's wasmtime didn't start (core §4.5): it comes with Codemm, so reinstalling brings it back.
  wasi: "Codemm couldn't start the part that runs your code.",
  // A container Docker refused for a reason core named: what to change, since trying again won't help.
  'docker-cpus': "Docker has fewer than the 2 CPUs a check uses. Give it more in Docker Desktop's settings.",
  'docker-log-driver': "Docker's logging driver refused Codemm's log options. Set it to json-file or local in Docker's settings.",
  'docker-file-sharing': "Docker can't share Codemm's run folders. Allow them in Docker Desktop's file sharing settings.",
} as const;
/** Run and lesson examples have no recovery screen, so their line says what to do next (§4.10). */
export const RUN_AGAIN: Record<string, string> = {
  [NOT_COUNTED.docker]: 'Open Docker Desktop, then run again.',
  [NOT_COUNTED['docker-busy']]: 'Wait a moment, then run again.',
  [NOT_COUNTED['docker-failed']]: 'Run again, and restart Docker if it happens again.',
  [NOT_COUNTED['docker-disk']]: 'Remove unused images in Docker Desktop, then run again.',
  [NOT_COUNTED.disk]: 'Free some space, then run again.',
  [NOT_COUNTED.offline]: 'Connect to the internet, then run again.',
  [NOT_COUNTED.wasi]: 'Reinstall Codemm, then run again.',
};
/** A run that didn't run: why, then what to do next. */
export const notRunLine = (reason: string) => (RUN_AGAIN[reason] ? `${reason} ${RUN_AGAIN[reason]}` : reason);
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
  /** Codemm can install this agent here, the vendor's own way (macOS and Windows; Claude Code and Codex). */
  canInstall: boolean;
  /** An install Codemm started, while it runs and after it ends. */
  install?: AgentInstall;
}

/**
 * Codemm installing an agent for the learner. Problems: `offline` and `disk` are this computer's; `unverified`:
 * the download didn't match the vendor's checksum or signature, so nothing ran (or, for a script's result, it isn't
 * used); `failed`: the vendor's installer didn't finish.
 */
export interface AgentInstall {
  phase: 'downloading' | 'checking' | 'installing' | 'done' | 'failed';
  /** 0 to 1 while downloading. */
  progress?: number;
  problem?: 'offline' | 'disk' | 'unverified' | 'failed';
}

// ---------- check this computer (§6.1) ----------

export type Platform = 'mac' | 'windows' | 'linux';
export type CheckId = 'docker-installed' | 'docker-running' | 'sandbox';

export interface ComputerCheck {
  id: CheckId;
  /** `waiting`: an earlier check has to pass first. */
  state: 'ok' | 'problem' | 'waiting';
  /**
   * For a running problem: Docker is still starting or set to Windows containers; or, on Windows, what WSL needs
   * first (set up, an update, virtualization turned on in the firmware, or a restart); or, just after Docker came up,
   * the sandbox is still being checked.
   */
  detail?: 'starting' | 'windows-containers' | 'wsl-missing' | 'wsl-old' | 'virtualization' | 'restart' | 'checking';
  /**
   * For the sandbox: the self-test's own words, when it knows the cause on this computer (core §4.3): offline, out of
   * disk, or Docker's (a folder to share, its sign-in helper). `inconclusive`: what it saw, not a known cause.
   */
  reason?: { kind: 'offline' | 'disk' | 'docker'; text: string; inconclusive?: true };
}

/**
 * Codemm installing Docker Desktop for the learner (§6.1). `wsl`: on Windows, WSL's own setup, which Windows asks
 * permission for; `admin`: Docker's installer as administrator, when Windows says it needs one; `starting`: installed and opened; Docker's own window asks the learner to accept its terms.
 * Problems: `offline` and `disk` are this computer's; `macos-version`,
 * `windows-version` and `windows-server`: Docker Desktop doesn't run on this macOS or Windows, so nothing downloaded
 * (an older Windows updates in Windows Update; Windows Server never runs it); `unverified`: the
 * download wasn't signed by Docker, so it was deleted; `manual`: drag Docker to Applications in the window that
 * opened; `declined`: the learner said no to Windows' permission prompt; `wsl-failed`: WSL's setup didn't
 * finish; `restart`: Windows needs a restart; `failed`: Docker's installer didn't finish.
 */
export interface DockerInstall {
  phase: 'wsl' | 'downloading' | 'checking' | 'installing' | 'admin' | 'starting' | 'failed';
  /** 0 to 1 while downloading. */
  progress?: number;
  problem?: 'offline' | 'disk' | 'macos-version' | 'windows-version' | 'windows-server' | 'unverified' | 'manual' | 'declined' | 'wsl-failed' | 'restart' | 'failed';
}

export interface Computer {
  platform: Platform;
  checks: ComputerCheck[];
  ready: boolean;
  /** Codemm can install and open Docker Desktop here (macOS and Windows). */
  canInstall?: boolean;
  /** An install Codemm started, while it runs and after it fails. */
  install?: DockerInstall;
  /**
   * Docker isn't ready, but Codemm's WASI engine runs here (core §4.5): practice with programs that read input and
   * print output runs without Docker, so the learner can go on. Docker stays an option for everything else.
   */
  wasi?: true;
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
  /** The course's name: the words typed for a course from before titles (W-5), else the agent's title, else the goal. */
  title: string;
  /** The goal the agent wrote, shown under the name when they differ. */
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
/**
 * Why setup failed. `gates` means the proposals didn't pass; the rest are this computer's problems: Docker stopped,
 * busy and not answering, or answering but failing, Docker's disk or this computer's, or the network.
 */
export type SetupProblem = 'offline' | 'disk' | 'docker' | 'docker-busy' | 'docker-failed' | 'docker-disk' | 'wasi' | 'gates';

/** What the learner approves before setup: exactly the files Codemm will build (§4.1). */
export interface Proposal {
  digest: string;
  /** True when an earlier proposal failed its gates: "Codemm has another way". */
  retry: boolean;
  /** On a retry, why the last proposal failed, in Codemm's words (never its output). */
  why?: string;
  files: { path: string; text: string }[];
}

export type TopicState = 'mastered' | 'now' | 'later';
/** `failed`: the job writing it stopped, and the learner tries again (§5). */
export type LessonState = 'writing' | 'failed' | 'ready' | 'read';
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
  /** The course's name (as Roadmap's): the map's heading, with the goal under it when they differ. */
  title: string;
  goal: string;
  track: string;
  setup: SetupState;
  setupProblem?: SetupProblem;
  proposal?: Proposal;
  topics: TopicView[];
  done: boolean;
  /** Background work (setup, lessons, activities) stopped after its retry, and why (§5). Nothing was recorded. */
  stalled?: 'plan-limit' | 'signed-out' | 'offline' | 'docker' | 'docker-busy' | 'docker-failed' | 'docker-disk' | 'disk' | 'wasi' | 'rebuild' | 'lesson' | 'failed' | 'unstoppable';
  /** The background work that stalled, so its banner can name it. */
  stalledWork?: 'setup' | 'lesson' | 'author';
  /**
   * The topic whose activity couldn't be written, when leaving it for later opens another topic: its banner offers
   * "Come back later", which unlocks the topics after it without mastering it (core §7).
   */
  later?: string;
}

/** One of the learner's courses, to switch to (§4.13). The id is opaque and never shown. */
export interface CourseSummary {
  id: string;
  title: string;
  /** Names the course when another has the same title. */
  goal: string;
  track: string;
  /** The course on screen. */
  current: boolean;
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
  /** How the examples run: io ones in the terminal pane with typed input (runExampleLive), unit ones once as tests. */
  style?: 'io' | 'unit';
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
      /** Another topic is ready, so "Come back later" moves on (§4.4). */
      later: boolean;
    }
  /** An infrastructure failure: nothing was recorded. */
  | { kind: 'not-counted'; reason: string };

/** Try it: visible tests only, never recorded. */
export type TryResult = { kind: 'ran'; passed: number; total: number; tests: TestView[] } | { kind: 'not-counted'; reason: string };

/** What the agent CLIs reported using (§4.12). `costUsd` is Claude's own estimate; Codex and Cursor report none. */
export interface UsageTotals {
  input: number;
  output: number;
  cachedInput: number;
  costUsd: number;
  runs: number;
}

/** A course's usage per job kind, and in total. */
export interface CourseUsage {
  kinds: Partial<Record<'research' | 'roadmap' | 'setup' | 'lesson' | 'author' | 'tutor', UsageTotals>>;
  total: UsageTotals;
}

/** The course on screen's usage. */
export type Usage = CourseUsage;

/**
 * A new version (DESIGN §7.2). `available`: an unsigned build, with the release's page. `downloading`, then
 * `ready`: a signed build, which offers Restart to update.
 */
export type UpdateStatus =
  | { kind: 'none' }
  | { kind: 'available'; version: string; url: string }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string };

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
  /** Installs a missing agent the vendor's own way; follow it with agents(). */
  installAgent(agent: AgentId): Promise<void>;
  /** Starts the agent's own sign-in where the learner sees it; the next agents() after they sign in shows it. */
  signIn(agent: AgentId): Promise<void>;
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
  /**
   * Downloads Docker Desktop from Docker, checks Docker signed it, installs and opens it; on Windows, sets up WSL first
   * when it needs it. Follow it with computer().
   */
  installDocker(): Promise<void>;
  /** Opens Docker Desktop. */
  openDocker(): Promise<void>;
  /** Opens Windows Update, for a Windows too old for Docker Desktop. Does nothing elsewhere. */
  openWindowsUpdate(): Promise<void>;
  /** Restarts Windows, when WSL or Docker's installer needs it. Does nothing elsewhere. */
  restartWindows(): Promise<void>;
  tracks(): Promise<Track[]>;

  /** Starts the research job on the first call; call again to follow it. */
  research(goal: Goal): Promise<Research>;
  /** Saves the learner's edits, then runs a roadmap-change job. */
  reviseRoadmap(concepts: Concept[], request: string): Promise<RoadmapChange>;
  /** Saves the roadmap, which becomes one of the learner's courses, on screen. If its track isn't installed, starts the setup job. */
  approve(concepts: Concept[]): Promise<void>;
  /** The roadmap written or edited but not approved yet, to resume. The approved course stays the course until then. */
  draft(): Promise<Roadmap | null>;
  /** Saves the learner's edits to the draft as they happen. */
  saveDraft(concepts: Concept[]): Promise<void>;

  course(): Promise<CourseView | null>;
  /** The learner's courses, oldest first, with the one on screen marked (§4.13). */
  courses(): Promise<CourseSummary[]>;
  /** Puts another of the learner's courses on screen; the work it still needs starts. */
  switchCourse(course: string): Promise<void>;
  /** Builds the proposal the learner saw. Also retries after an offline or low-disk failure. */
  install(digest: string): Promise<void>;
  /** Runs the setup job again, after its proposals failed their gates. */
  retrySetup(): Promise<void>;
  /** Starts the stalled background work of the course on screen again. */
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
  /** Run for a lesson's io example `index`, as runProgram is for an activity: typed input, output through onRunOutput. */
  runExampleLive(lessonId: string, index: number, run: string): Promise<RunResult>;
  check(activityId: string, run?: string): Promise<CheckResult>;
  /**
   * Run: the learner's program with typed input, time-limited, never recorded. Resolves when it ends; what it prints
   * arrives through onRunOutput, tagged with `run`, and only in the window that started it.
   */
  runProgram(activityId: string, run: string): Promise<RunResult>;
  /** Typed input for a Run this window started. False if it wasn't taken: the run ended, or too much is waiting. */
  sendRunInput(run: string, text: string): Promise<boolean>;
  /** Ends a Run's input, as Ctrl+D does in a terminal, so a program that reads until the end can finish. */
  endRunInput(run: string): Promise<void>;
  /** Stops a Run this window started. */
  stopRun(run: string): Promise<void>;

  /** A tutor turn. A reply that shows hidden material is held back (§2.2). */
  ask(place: Place, text: string): Promise<Message[]>;
  /** "Come back later": defers the concept without changing mastery (§4.4). */
  skip(concept: string): Promise<void>;
  /** "Try an easier one": a roadmap-change job that adds a prerequisite topic (§3.2). */
  easier(concept: string): Promise<void>;

  rebuild(trackRef: string): Promise<void>;

  /** What the agent CLIs reported using for the current course (§4.12); null without a course. */
  usage(): Promise<Usage | null>;
  /** Whether a new version is out (§7.2). */
  update(): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update: a signed build whose update is `ready`. */
  restartToUpdate(): Promise<void>;
}

/** One thing a job did: a web search, an https page (host and path) or one of Codemm's steps (§4.11). */
export type JobStep = { kind: 'search'; query: string } | { kind: 'read'; url: string } | { kind: 'step'; label: string };

/** The agent jobs (§3.2): research, a roadmap change, setup, a lesson, an activity (author) and a tutor turn. */
export type AgentJobKind = 'research' | 'roadmap' | 'setup' | 'lesson' | 'author' | 'tutor';

/** Everything that reports progress (§4.11): the agent jobs, and Codemm's own rebuild of a track. */
export type JobKind = AgentJobKind | 'rebuild';

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
  /** The track's name (not its ref), for a rebuild. */
  track?: string;
  stage: number;
  /** The latest steps, newest first, at most 8. */
  steps: JobStep[];
  /** How many steps so far. */
  count: number;
  /** A real fraction within the stage: a setup's build steps, or which of the exercise's 3 gates runs. */
  part?: { done: number; total: number };
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
