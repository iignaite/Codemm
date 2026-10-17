# Codemm desktop 1.0 design

Status: revised after Astra's review and re-check, with the owner's approved additions (lesson gate, usage, CLI pinning, minimum model, Docker onboarding, beta, signing) reviewed by Astra (§14). The owner decided O8 and O9 (decisions 10 and 11). Approving it needs the owner's decision O8. It extends the core spec, `docs/DESIGN.md`, which stays authoritative for the harness. The core changes in §4 move into `docs/DESIGN.md` in the same PR as their code. The journeys follow the approved prototype (`codemm-journeys.html`, outside this repo). Agent CLI evidence: [agent-bridge.md](agent-bridge.md).

## Decisions

| # | Decision |
|---|---|
| 1 | 1.0 ships the core harness plus an Electron app for macOS, Windows and Linux. |
| 2 | The Electron main process calls core `app` functions in-process. The renderer reaches main only through a typed preload API whose handlers are thin and check their sender. |
| 3 | The renderer gets learner-safe data only: never solutions, mutants, hidden tests, expected outputs, author transcripts, tool arguments, agent stderr or debug logs. |
| 4 | "Codemm never calls a model" now reads: **Codemm launches the learner's own agent CLI. It never calls a model API, and it never reads, stores or asks for credentials.** |
| 5 | Each agent run is one job. A job has a short brief, a Codemm server bound to its course that exposes only that job's tools, the narrowest built-in tools the agent allows, a deadline, a retry bound and a check for whether it worked. Authoring runs in its own process and is never streamed. |
| 6 | Installing a track stays its own decision. In the app, `save_track` only proposes a track. Codemm builds exactly the files the learner approved, after they click Set up, and never on roadmap approval. |
| 7 | New core features are the smallest needed: lessons with sandbox-checked runnable examples, roadmap read, research sources, a `setup` step, honest skip, install progress events, per-job servers and learner file saves. Review scheduling is deferred. |
| 8 | Installers are built with electron-builder. Beta builds are unsigned. The public 1.0 is signed and auto-updates (§7.1). |
| 9 | A private beta with 5 to 10 learners comes before the public 1.0 ([beta-plan.md](beta-plan.md)). |
| 10 | **O8, decided by the owner:** the invariant now reads "Hidden data never leaves Codemm through Codemm's own outputs (tools, CLI, IPC and diagnostics). An agent with file access can read Codemm's files; Codemm removes that access where the agent allows." (`AGENTS.md`). Codex ships in the app with the reply filter (§2.2). |
| 11 | **O9, decided by the owner:** beta testers get unsigned builds with open-anyway instructions, and the public 1.0 is signed (D29). |

## 1. Scope

1.0 is the core harness (`docs/DESIGN.md`, A1 to A16) plus a desktop app that runs the six journeys in the prototype: connect, learn anything, lessons, activities, course, and failure states.

**Release order:**

1. The journeys D14 to D17 pass.
2. A private beta runs with 5 to 10 learners, one course each, as [beta-plan.md](beta-plan.md) describes.
3. The public 1.0 ships only after the beta's exit criteria pass (D28) and the owner approves. Core §2 listed the human beta as deferred; it moves here.

Changes from the prototype, following Astra's design review:

- "Best path" becomes "Suggested path".
- Lessons hold examples and predict questions. Examples marked runnable are run in the sandbox before the lesson is shown (§4.4). Agent-written code never runs in the app itself.
- The review card and streaks are cut (deferred, §12).
- Environments come from `list_tracks`. Nothing in the app is per-language.

UI rules:

- Use minimal wording.
- No status dots, arrows or metadata (ids, versions, paths or timestamps).
- Nothing should look like Claude's UI or copy Duolingo.
- The tutor and every action are "Codemm". Agent names (Claude Code, Codex, Cursor) appear only on the connect screen.
- The connect screen carries the disclosure "Codemm uses your agent and your plan." Every agent job starts from a learner action or the approved flow, and the bounds in §3.2 cap how much of the plan it uses.

## 2. Architecture

```
desktop/
  src/shared/api.ts         the IPC contract: channel names, input and output types
  src/preload/preload.ts    contextBridge exposes `codemm.*` from api.ts; nothing else
  src/main/
    main.ts                 window, app lifecycle, menu
    ipc.ts                  one handler per channel: check the sender, validate input, call one function, return a view
    views.ts                learner-safe projections of core results, and the reply filter (§2.2)
    state.ts                desktop.json in userData: chosen agent, executable path, tutor session ids
    agent/agents.ts         per agent: launch arguments, stream parser, sign-in check
    agent/bridge.ts         spawn, line parsing, cancellation, sign-in (proved in spikes/agent-bridge)
    agent/jobs.ts           job kinds: brief, tools, permissions, deadline, retry bound, done check (§3.2)
  src/renderer/             screens only; no Node, no file or process access
```

- **Core in-process.** Main imports the core's `app` module from the repo and bundles it. `app` stays the only place that holds use cases, so the CLI, the MCP server and the app share them.
- **Two processes write course data.** These are main and the `codemm mcp` server that each agent job starts. The core's PID-based course, track and workspace locks already serialize them.
- **One server per job.** Each job's MCP server is the app's own binary in Node mode: `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/core/cli.js mcp --workspace <ws> --course <course> --tools <list> --desktop`. The Electron `RunAsNode` fuse must stay on.
- **One workspace.** The app keeps one workspace (default `~/Codemm`) holding `codemm.json` and `exercises/`. The course, events and tracks stay under `$CODEMM_HOME`, as in core. `desktop.json` carries `format_version` and is written atomically, like every Codemm-owned file.

### 2.1 Renderer security

- **Window settings.** Windows set `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`. They load the app's own `app://codemm` origin.
- **CSP.** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. The page can make no remote request, including for images.
- **Markdown.** Lessons and agent text are rendered with raw HTML stripped:
  - An image with a remote URL renders as a plain link.
  - Links keep only `https:` URLs.
  - Code blocks are highlighted, never run.
- **Navigation.** Navigation, `window.open` and webviews are denied. `shell.openExternal` opens a link only after a click, and only for `https:` URLs.
- **IPC senders.** Every handler checks that `event.senderFrame` is the main window's top frame on `app://codemm`, and rejects anything else.

### 2.2 The learner-safe boundary

- **IPC.** Every IPC result is built in `views.ts` from core results that are already learner-safe: `getExercise`, `CheckView`, `progress`, `getRoadmap`, `getLesson`, `listTracks`, and the learner file reads. Hidden results carry only an index and a status, as in core §4.2.
- **Agent events.** Only `text` events from tutor, assist and roadmap-change turns reach the renderer. For other jobs the renderer sees a job state (`running`, `checking`, `retrying`, `done`, `failed`).
- **Never forwarded.** Author, setup and lesson job streams, tool arguments and results, agent stderr, and sign-in output.
- **Reply filter.** Before forwarding text, main compares it with the current exercise's solution, mutants, hidden tests and expected outputs. If any normalized line of at least 24 characters from that material appears verbatim, the message is replaced with "Codemm held back a reply that showed hidden material." This is a backstop, not proof: a paraphrase passes it.
- **Honor system.** As in core §1 and §4.2, grading is on the honor system, and hidden tests are hidden from the agent's tools, not from the computer. §3.1 says how much each agent can still read.
- **Tests.** A canary test enforces the boundary (D4).

## 3. The agent bridge

### 3.1 Launch, isolate, stream, cancel, sign in

Proved for Claude Code and Codex in [agent-bridge.md](agent-bridge.md). Cursor is unverified.

| | Claude Code | Codex | Cursor (unverified) |
|---|---|---|---|
| Headless turn | `claude -p <brief> --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check <brief>` | `cursor-agent -p --output-format stream-json --approve-mcps --workspace <ws>` |
| Codemm server | `--mcp-config <json> --strict-mcp-config` | `-c mcp_servers.codemm.{command,args,env}=…` | `<ws>/.cursor/mcp.json` (no flag exists) |
| Codemm tools | `--allowedTools mcp__codemm__<tool>,…` | `-c mcp_servers.codemm.enabled_tools=[…]`, then `default_tools_approval_mode="approve"` | `--approve-mcps` |
| Built-in tools | `--tools ""`, or the job's list (§3.2) | `--ignore-user-config`, `--disable shell_tool --disable unified_exec --disable browser_use --disable computer_use --disable apps --disable multi_agent`, and `-c sandbox_mode="read-only"` | `--mode ask` |
| Follow-up turn | `--resume <session_id>` | `codex exec resume <thread_id>` | `--resume <chatId>` |
| Sign-in check | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in" | `cursor-agent status`, "Not logged in" |

**What isolation holds.** These were tested with a canary file the agent was asked to read (agent-bridge.md, finding 7).

- **Claude Code.** `--tools ""` leaves only the Codemm server's tools, with no shell and no file reads. The canary was not read. The per-job `--tools` filter on the server (§4.8) then limits those to the job's own.
- **Codex.**
  - The read-only sandbox blocks writes and network, but **not reads**: with the shell on, `cat` of the canary succeeded (`codex-readonly-shell-reads.jsonl`). So the shell features must be off.
  - `--ignore-user-config` drops the learner's own MCP servers and plugins. Without it, the owner's computer-use server loaded even with `computer_use` disabled. It also means Codex uses its default model rather than the learner's (O6), which made runs about three times faster.
  - `enabled_tools` limits the Codemm tools, and `multi_agent` is off.
  - What remains is Codex's code mode (`functions.exec`). It can't be turned off, because Codex calls MCP tools through it: disabling `code_mode_host` also removed the Codemm tools. Asked to read the canary through it, the model declined to try. **Whether code mode can read files is unproven**, so Codex is not proven confined.
  - For Codex, hidden data is protected by the reply filter (§2.2) and the honor system, under the reworded invariant (decision 10).
- **The invariant.** Codemm never runs agent-written code on the host. Codemm runs untrusted code only through `sandbox.ts`. What the agent's own tools do happens under the agent's own sandbox, exactly as in a terminal. Turning those tools off is defense in depth.

**Running processes.**

- **Spawning.** The bridge uses argument arrays, no shell, and closed stdin (both CLIs otherwise wait on stdin). Each agent leads a new process group.
- **Cancelling.**
  - On POSIX it sends SIGTERM to the group, then SIGKILL after 3 s, and resolves only when the group is gone.
  - On Windows it awaits `taskkill /pid <pid> /t /f`.
  - A job that is already cancelled never starts.
  - If the group survives SIGKILL, or `taskkill` fails, the run reports `stopped: false`. The job fails with "Codemm couldn't stop your agent. Quit Codemm to stop it." and is never reported as cleaned up.
  - After a cancel or crash, main runs the core's leftover-container cleanup (`doctor --fix`'s rule: only containers whose owner process is gone), because killing an MCP server mid-check skips its own cleanup.
- **Robustness.**
  - A stream line that is malformed or makes the parser throw is skipped.
  - A line over 1 MB is dropped before parsing, whether or not it ends in a newline.
  - Sign-in checks answer "not signed in" at 10 s, even if a child keeps the pipe open, and then stop their process group. They read at most 64 KB of output.
- **Streaming.** Each stdout line is parsed into common events: `session`, `text`, `tool_call`, `tool_result` and `done`. Both CLIs emit whole messages, not tokens, so the panel shows a working state until each message arrives.

**Credentials and environment.**

- Codemm never opens an agent's credential files or keychain entries.
- Sign-in uses the agent's own status command. Only a yes or no leaves the bridge, and the output is dropped.
- Signing in is the learner's job in their agent ("Not signed in. Sign in to Codex first." then Try again).
- The agent gets the app's environment unchanged. Codemm adds and removes nothing (open decision O1).

**Finding and launching agents.**

- GUI apps don't load shell profiles. The app looks on `PATH` and in the usual install folders, and on the connect screen the learner can pick the agent's executable.
- A native executable runs directly.
- A JavaScript entry point (a `#!/usr/bin/env node` launcher, like the npm-installed Codex) runs as `ELECTRON_RUN_AS_NODE=1 <app executable> <script>`, so no system Node is needed.
- On Windows, an npm `.cmd` shim is never run, because that needs a shell. The app reads the script path from npm's fixed shim format and runs that script the same way.
- The same lookup adds Docker's folder to `PATH` for core calls.
- D1 tests all of this in the packaged app.

### 3.2 Jobs

| Job | Codemm tools | Built-in tools | Done when |
|---|---|---|---|
| Research and roadmap | `list_tracks`, `save_roadmap` | web search and fetch (Codex's web tool is on by default) | the job's course exists with at least one source |
| Roadmap change ("Ask Codemm for changes") | `get_roadmap`, `save_roadmap` | none | the course record changed, or the turn ended without error and without a save (shown as "No change" with the agent's text) |
| Setup | `list_tracks`, `save_track` (proposes only) | none | a new proposal exists for the job's track |
| Lesson | `get_roadmap`, `save_lesson` | none | a new lesson exists for the job's concept |
| Author | `next_step`, `save_exercise` | none | a new exercise exists for the job's concept and difficulty |
| Tutor | `progress`, `next_step`, `get_exercise`, `get_lesson`, `mark_lesson_read`, `get_roadmap`, `list_tracks` | none | the turn ends without error |
| Assist | `get_exercise` | read and edit, confined to the exercise folder | the turn ends without error |

- **Bound to a course.** Every job's server gets `--course <course>`, so switching courses in the app can't redirect a job's save.
- **Checking the result.** "Done when" is checked against core records created after the job started, never against the agent's text. Before relaunching a failed job, main checks again, because a save can commit just before a crash.
- **Fresh sessions.** Author, setup, lesson and assist jobs start without history. They are cheaper, and an author job can't see the tutor's chat (or the tutor the author's). The tutor resumes one session per course, from the same workspace folder, because both CLIs keep sessions per working directory.
- **Concurrency.** At most two agent processes run at once: one foreground job and one background queue. After approval, the first lesson runs in the foreground while setup, then authoring, runs in the background ("Reading starts as soon as the first lesson exists").
- **Bounds.**

  | Job | Deadline | Retry bound |
  |---|---|---|
  | Research | 10 min | — |
  | Setup | 10 min per proposal, then core's 10 min build limit | 3 proposals per setup |
  | Lesson | 5 min | 3 failed `save_lesson` calls |
  | Author | 15 min | 3 failed `save_exercise` calls |
  | Tutor and assist | 5 min | — |

  The bridge counts failed saves from `tool_result` events and cancels the job at the bound. A failed job is relaunched once at most. After that, the learner gets the failure screen (§5).
- **Practice protection.** Tutor turns have no edit tools in Claude Code or Codex, so this doesn't depend on the Claude hook. It is still not a security boundary (§3.1).
- **Assist.** "Let Codemm edit?" works like this:
  1. `app.setAssist(ws, true)`, which records the assist event for the current exercise first (core §7).
  2. One assist job, run with its working folder set to that exercise's folder:
     - Claude Code: `--tools Read,Edit` and `--allowedTools "Edit(./**)"`.
     - Codex: `-c sandbox_mode="workspace-write"`, which allows writes only under the working folder.
  3. `app.setAssist(ws, false)` when the turn ends, however it ends. The app also clears it at startup, so an interrupted assist never leaves it on.

  While the assist turn runs, the app doesn't switch exercises, so assist can't mark another exercise. Stop cancels the turn and clears assist.

  The exercise keeps its assist event, so its checks count a quarter. A new exercise follows because the concept isn't mastered yet.
- **Stuck.**
  - "Reread the lesson" opens the lesson.
  - "Try an easier one" runs a roadmap-change job that adds a prerequisite topic. The stuck topic then waits for it, and gets a fresh start afterwards (§4.2).
  - "Come back later" is skip (§4.5).

### 3.3 Agent CLI versions

- **Tested versions.** `agents.ts` lists the CLI versions that the fixtures and the live contract test passed on. They start with Claude Code 2.1.283 and Codex 0.156.1. Cursor has none yet.
- **Startup check.** At startup and on the connect screen, the app runs `<agent> --version` with the same deadline and output cap as the sign-in check. An untested version shows "Untested version. It may still work." on that agent's connect row. It warns and never blocks. (The spike's `status` command does this.)
- **Contract tests.**
  - In CI, the recorded streams for each tested version must parse to their expected events, usage included.
  - Before a version is added to the list, the owner or a release step runs a live contract test (`npm run test:agents`, outside CI, with signed-in agents and a small model). It covers one turn with Codemm tool calls, a resume and a cancel, and it checks the event shapes and that no process is left. A new version passes only if it does, and its streams are recorded as fixtures.

### 3.4 Usage

- **Recording.** When an agent process exits, however it exits, main appends exactly one record to `<userData>/usage/<course>.jsonl`: `{ format_version, at, job, concept, lesson?, exercise?, agent, session?, costUsd?, inputTokens?, cachedInputTokens?, outputTokens? }`.
  - The numbers are what the CLI reported in its `done` event, success or failure. Claude Code reports `total_cost_usd`, an API-equivalent estimate even on a plan. Codex reports token counts per turn.
  - A run that ends without a `done` event, such as a cancel or a crash, is still recorded, with no numbers.
  - **Resumed tutor sessions.** A resumed Claude Code session reports a total that includes earlier turns. For a resumed session, `costUsd` is the reported total minus the last total recorded for the same `session`, or the reported total if that would be negative. The live contract test (§3.3) checks this on each tested version.
  - Each record is one agent run, so relaunches and tutor turns count. The number of runs per lesson or activity is the record count.
  - The file is append-only, and a torn last line is ignored, as with core's event log.
- **Showing it.** The course view shows rough figures per topic, rounded to two significant digits:
  - "About $0.40 of agent use" for reported costs;
  - "About 120k tokens" for reported tokens. Both appear when a topic used both agents, because costs and tokens can't be added up honestly.
  - "At least" goes before the figure when any run on the topic reported nothing.
  - Codemm keeps no price table.
- **Caching.** Saved lessons are read from the course store. Reopening a lesson, or going back to an activity, starts no agent job.

## 4. New core capabilities

Each addition lands in its own module (`schemas`, `store`, `learner`, `app`, `mcp`), with a thin MCP tool where the agent needs it.

### 4.1 Install consent in the app

- **Proposals.** `codemm mcp --desktop` changes `save_track` only:
  1. It runs track gate 1: valid files, and `id@version` new or identical.
  2. It stores the files as an immutable proposal under `$CODEMM_HOME/proposals/<id>@<v>/<digest>/`. The digest is SHA-256 over the canonical file map.
  3. A newer proposal for the same `id@version` replaces older ones.
  4. It returns `{ proposed: "id@v" }` and the note "The learner decides in Codemm. End your turn."
  Writes are atomic and versioned and hold the track lock.
- **Installing.** The new `app.listProposals()`, `app.installProposal(ref, digest, onProgress)` and `app.dropProposal(ref)` let main install a proposal.
  - Under the track lock, `installProposal` re-reads the files and recomputes the digest. It refuses unless the digest equals the one the learner was shown.
  - It then runs gates 2 to 5 and installs exactly like `saveTrack`.
- **The consent dialog.**
  - Text: "Set up React on this computer?" and "Setup runs code your agent wrote, with internet access. Graded runs are offline.", with Not now or Set up. This replaces the prototype's "Downloads once", which hid the network build (Astra re-check).
  - Details shows the Dockerfile and track.yaml, the 10-minute build limit, and the fact that builds have no memory or CPU limit.
- **Retries.** If a build fails, a new setup job gets the gate diagnostics (track diagnostics hold no learner secrets) and proposes again, within the bound in §3.2. Every new proposal has new contents, so it asks again: "Codemm has another way to set up React." with Stop or Set up.
- **Outside the app.** Roadmap approval never installs anything. Without `--desktop`, `save_track` behaves as in core: approving the call in the agent is the consent.

### 4.2 Roadmap read and edit

- **Draft before setup.**
  - `save_roadmap` accepts a track that isn't installed yet, if it is a valid `id@version`.
  - `next_step` returns `{ kind: "setup", track }` until it is installed.
  - Re-saving may change `track` while the course has no exercises and no lesson with runnable examples, so a failed setup can move to another track. Before that save, main cancels the old track's setup and author jobs and drops its proposals. Lessons without runnable examples stay, because they are static text the learner can edit. A course that has a lesson with runnable examples can't change track, because those examples were checked on the old one.
  - `save_exercise`, `get_exercise` and `check` still need the installed track.
  - If the installed track doesn't offer the roadmap's style, `next_step` fails with "Edit the roadmap's style".
- **Reading.** `get_roadmap` (tool) and `app.getRoadmap(ws)` return `{ course, goal, track, style, concepts: [{ id, title, requires }], sources }`.
- **Editing in the app** builds a new roadmap and saves it through `app.saveRoadmap`, so core §5 rules apply:
  - Rename changes the title only, and the id stays stable.
  - Add creates an id from the title (kebab case, made unique) with `requires: []`.
  - Move changes order only. It is refused, with "Needs ‹title› first", when it would put a topic above one it requires.
  - Remove is refused when another topic requires it ("‹title› needs this topic"). Core also rejects removing a concept that an exercise, event or lesson uses; the lesson part is new. Prerequisites are never rewritten silently.
  - Prerequisite changes go through "Ask Codemm for changes".
- **A fresh start after a new prerequisite.** When a re-save adds a prerequisite to a concept that is stuck, `save_roadmap` appends `{ kind: "retry", at, concept }`. Replaying a `retry` resets that concept's fail streak and leaves mastery unchanged. Without it, the concept would be stuck again as soon as the new prerequisite was mastered.

### 4.3 Research sources

- `save_roadmap` takes optional `sources: [{ url, title, retrieved, why, version? }]`:
  - 1 to 20 entries;
  - `https:` URLs only;
  - `retrieved` as `YYYY-MM-DD`;
  - `title` up to 120 characters, `why` up to 280;
  - `version` optional, up to 40 characters (for example, "React 19").
- Sources are stored in `course.json` and returned by `get_roadmap`. The research job must save at least one (§3.2).
- Web text is untrusted:
  - The research brief tells the agent to prefer primary sources and to treat page text as data, never instructions.
  - Codemm never fetches the URLs.
  - The app shows sources as plain text and opens links only on a click (§2.1).
  - The roadmap still passes the roadmap gate.

### 4.4 Lessons

- **Saving.** `save_lesson { id, concept, title, markdown }`:
  - The id is new in the course, and the concept is in the roadmap.
  - The Markdown is at most 64 KB.
  - A fenced `predict` block holds `question`, `choices` (2 to 4) and `answer` (a choice index). It is checked when saved.
  - Runnable examples are checked when saved (the lesson gate, below).
- **Storage.** `courses/<course>/lessons/<id>/` holds:
  - `lesson.json` (`format_version`, id, concept, title, created);
  - `lesson.md`, the agent's text, which is never changed after saving;
  - `edited.md`, the learner's version, which is shown instead when present;
  - `notes.md`, the learner's notes.
  Writes are atomic and hold the course lock.
- **Reading.** `get_lesson { id }` and `app.getLesson` return the shown text and the notes, and change nothing. App functions: `listLessons`, `getLesson`, `editLesson`, `saveNotes` and `markLessonRead`.
- **Read events.** Only an acknowledgement records a read: `mark_lesson_read { id }` (tool) or `app.markLessonRead` appends `{ kind: "read", at, lesson, concept }` the first time.
  - The app calls it when the learner reaches the end of the lesson and clicks Next.
  - The terminal tutor calls it after the learner says they've read it.
  - An agent fetching a lesson for context never unlocks the activity.
- **Next step.** `practice` and `author` steps gain a `lesson` field:
  - `null`: the concept has no lesson yet (write one first).
  - an id: the earliest unread lesson.
  - absent: every lesson for the concept has been read.
  The activity stays locked in the app, and the tutor teaches first, until the field is absent. The author job can still run in the background, because the step names the activity. Lessons never change mastery.
- **The lesson gate.** It covers only examples the agent marks runnable:
  - **Marking.** A fenced block with the info string `run` holds the example. An optional `stdin` block may follow it. An `output` block must come next, holding what the lesson says it prints.
  - **What it runs on.** The body becomes the track's single learner file, so runnable examples need an installed track with one learner file and the `io` style. Otherwise `save_lesson` rejects runnable blocks ("Set up the track first, or mark no example runnable"). The first lesson, written while setup runs, therefore has no runnable examples.
  - **Running.** A lesson may hold at most 5 runnable examples. Each one is a different program, so each runs separately through the judge as a one-case io run: its own build, its own container, every §4.3 flag and the track's limits. The output is compared with core's io normalization.
  - **Locking.** A lesson with runnable examples holds the track lock, then the course lock (the order `save_exercise` uses), from validation through commit. A rebuild therefore can't swap the image between the check and the save.
  - **Results.** If an example fails to build, errors, times out or prints something other than its `output` block, `save_lesson` saves nothing. It returns which example failed, with the expected and actual output, since lesson examples are public. The lesson job retries within its bound (§3.2), then fails into §5. An infrastructure failure saves nothing and is reported as one.
  - **Rebuilds.** `track rebuild` re-runs every saved lesson's runnable examples along with the exercises, and fails, listing the lessons, if any output changed.
  - **Track changes.** Once a course has a lesson with runnable examples, its track can no longer change (§4.2).
  - **Not covered.** Prose and non-runnable code are checked for structure only, and a learner's edits aren't re-run. The learner can edit a lesson or tell Codemm when it reads wrong.

### 4.5 Honest skip and retry

`skip` now means "Come back later". It doesn't mean "I already know this".

- A `skip` event defers the concept without changing mastery.
- Candidates are still the concepts that aren't mastered and whose prerequisites are all mastered. A deferred concept never counts as a mastered prerequisite.
- Non-deferred candidates come first. If every candidate is deferred, the earliest in topological and roadmap order is chosen.
- The deferral ends at the concept's next check.
- `done` still needs every concept mastered.
- A `retry` event (§4.2) resets the concept's fail streak, so stuck ends without granting mastery.
- The CLI help changes to "come back to a concept later". 1.0 isn't published, so the change needs no migration.

### 4.6 Install progress events

`installProposal` and `saveTrack` take an optional `onProgress({ step, state })`. Steps are `build`, `pass-probe`, `fail-probe` and `repeat`. States are `running`, `passed` and `failed`. Events carry no diagnostics.

Exercise gates run in the job's MCP server, so the app derives the author job's state from the stream instead: a `save_exercise` call means `checking`, and a failed result means `retrying`. No new channel is needed.

### 4.7 Learner files

- **Reading.** `app.readLearnerFiles(ws, slug)` returns `{ path: { text, digest } }` for that exercise's track files only.
- **Saving.** `app.writeLearnerFile(ws, slug, path, text, digest)`:
  - holds the workspace lock;
  - accepts only that exercise's track files;
  - refuses any path whose components include a symlink;
  - replaces the file through a temp file and a rename;
  - refuses with "Changed outside Codemm" when the file's current digest isn't the one the editor loaded. The editor then reloads.
- **During assist.** The editor is read-only while an assist turn runs and reloads when it ends.
- **Tests and checks.** Run tests calls `testExercise`, and Check calls `checkExercise`.

### 4.8 Per-job MCP server

`codemm mcp` gains two options:

- `--course <course>` makes course-scoped tools use that course instead of the workspace's active one.
- `--tools <list>` registers only the listed tools.

With neither option, the server behaves as in core.

## 5. Failure states

Infrastructure failures record nothing. Learner-caused outcomes are graded as `error` and recorded (core §4.3, §7).

| What happened | What the learner sees | Recorded |
|---|---|---|
| Docker not running, or the host deadline passed | "This check wasn't counted. Docker isn't running. Start it, then try again." | nothing |
| Track image missing or changed | "Rebuild" on the track; runs `rebuildTrack` | nothing |
| No agent found, or not signed in | the connect screen with its fix | nothing |
| An agent run fails (model refused, rate limit, crash, deadline) or isn't done by its check | "Codemm couldn't finish that." Try again or Check your agent (opens connect) | nothing; saves are atomic |
| Track gates fail | "Couldn't set up React." A new proposal asks again; after the bound, Stop or Try again | nothing |
| Author bound reached | "Couldn't write this activity." Try again | nothing |
| Editor file changed outside Codemm | the editor reloads it | nothing |
| A course is busy (lock) | a working state; core waits up to 10 minutes | nothing |
| Corrupt event log | "Codemm's records need a repair." with the doctor result | nothing |
| App quits or cancels during a job | agent process groups are killed, then leftover containers are cleaned up | nothing |
| Build error, timeout or output flood in learner code | the test results, as errors | a `check` event |

## 6. Cross-platform support

| OS | Container runtime | Status for 1.0 |
|---|---|---|
| macOS (arm64, x64) | Docker Desktop | verified, journey D14 |
| Windows 11 x64 | Docker Desktop with the WSL2 backend; the app runs natively and calls `docker.exe` | D15, otherwise experimental (O3) |
| Linux x64 | Docker Engine; the user must be in the `docker` group or run rootless | D15, otherwise experimental (O3) |

- Core cross-platform fixes and CI belong to the cross-platform core work (PR #16), including the container user on each platform and per-OS runtime help (`runtimeHelp` in `src/sandbox.ts`).
- The app adds runtime and agent discovery (§3.1) and process-tree cancellation on Windows.

### 6.1 Check this computer

The first run, and every Docker failure in §5, opens "Check this computer". It has three rows, run in order, from core's `doctor` checks:

| Step | Passes when | Fix shown on failure |
|---|---|---|
| Docker is installed | the `docker` CLI is found (§3.1 lookup) | macOS and Windows: "Install Docker Desktop." Windows adds the WSL 2 backend. Linux: "Install Docker Engine." Each has a link to Docker's install page. |
| Docker is running | the daemon answers | macOS and Windows: "Open Docker Desktop." Linux: "Start Docker", plus "Add yourself to the docker group, then sign out and in" when access is denied. The wording comes from core's `runtimeHelp`. |
| The sandbox works | doctor's network check passes | "Codemm couldn't confirm the sandbox. Restart Docker and check again." |

- Only the first failing row shows its fix.
- Only one check runs at a time. The next one starts 5 seconds after the last finishes, or at once when the window regains focus and no check is running. Re-checking stops once every row passes, and Continue unlocks.
- Colima, and Podman on macOS, are deferred until after 1.0 (§12).

## 7. Packaging

- **Installers.** electron-builder produces a dmg and zip on macOS (arm64 and x64), NSIS on Windows (x64), and AppImage and deb on Linux (x64).
- **Bundled core.** The core is bundled under resources (unpacked from asar) for the MCP server.
- **Unsigned for the beta.**
  - On macOS 15 and later: open the app once, then choose System Settings, Privacy & Security, Open Anyway. Right-click and Open no longer works for unnotarized apps.
  - Windows SmartScreen needs More info, then Run anyway.
  - The beta guide states both ([beta-plan.md](beta-plan.md)).
- **CI.** CI builds installers on all three OSes and keeps them as artifacts. Nothing is published.

### 7.1 Signing and auto-update (decision)

**Decision.** Beta builds stay unsigned. The public 1.0 is gated on D29: the macOS build signed and notarized, and the Windows build signed. The owner confirmed this (O9, decision 11). Then turn on auto-update with electron-updater, publishing to GitHub Releases. Auto-update stays off until builds are signed:

- macOS updates (Squirrel.Mac) work only for signed apps.
- An unsigned Windows update shows SmartScreen warnings. Signing doesn't remove them at once, because reputation builds over time, but it is the requirement for building it.
- Signing all three platforms at once keeps the update path the same everywhere.

**Why it waits.** Signing needs accounts only the owner can hold:

| Platform | What's needed | Rough cost (check at purchase) |
|---|---|---|
| macOS | Apple Developer Program membership, a Developer ID Application certificate, and an App Store Connect API key for notarization | US$99 a year |
| Windows | One of these: Azure Artifact Signing (formerly Trusted Signing), open to individuals only in the USA and Canada and to organizations in those countries, the EU or the UK; or a cloud-signing OV certificate from a certificate authority | Azure: US$9.99 a month. OV certificate: roughly US$200 to $500 a year. |
| Linux | nothing; AppImage and deb need no signature for updates | — |

**Owner steps:**

1. Join the Apple Developer Program (as an individual, or as an organization with a D-U-N-S number).
2. Create a Developer ID Application certificate and export it as a `.p12` file. Create an App Store Connect API key.
3. Pick the Windows option you're eligible for and set up its signing account.
4. Add the GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, plus the Windows provider's credentials.
5. Approve the first signed GitHub Release. Releases are published only with the owner's go-ahead.

**Then (D29):** the CI build is notarized (`spctl -a -vv` accepts it), the Windows installer passes `signtool verify /pa`, and a test install updates from version N to N+1 on each OS.

## 8. Cross-model robustness

The flow must work from weak to strong models.

- **Gates are the net.** Tracks, roadmaps and exercises reach the learner only after their gates pass. A weak model costs retries, not inconsistent activities. As core §1 says, gates prove internal consistency, not that a statement teaches the right thing.
- **Short, single-purpose briefs.** Each job brief is at most about 25 lines, and the job's server exposes only its own tools. With `--tools ""`, Claude Code loads Codemm's tools directly, without the lazy ToolSearch step (agent-bridge.md, finding 5). Briefs live in core `templates.ts` and name no language.
- **No subagents needed.** The app runs authoring as its own process. Hosts or models that handle subagents poorly still get isolation.
- **Specific errors and bounded retries.** Tool inputs are validated with specific messages that the agent can act on. Retries are bounded (§3.2), and each job's done check reads core records.
- **Bench.** The cross-model bench (`bench/`) supplies evidence per model.
- **Minimum model.** `desktop/src/shared/models.json` holds a recommended minimum model per agent, filled from the bench results in `docs/bench`. When it is set, the agent's connect row shows "Recommended: ‹model›". Because Codex jobs ignore the learner's config (§3.1), the app passes exactly that model with `-m`. Claude Code jobs keep the learner's default.
  **Placeholder:** both entries are `null` until the bench results land. Until then the row shows nothing, and Codex uses its default model.

## 9. Acceptance criteria

Each item is verified by an automated test unless marked *journey*.

| # | Requirement |
|---|---|
| D1 | CI builds installers on macOS (dmg), Windows (NSIS) and Linux (AppImage, deb), unsigned for the beta. On each OS, the packaged build, with no system Node on `PATH`: (a) launches to the welcome screen; (b) starts its own MCP server through `ELECTRON_RUN_AS_NODE`, which a test client calls `list_tracks` on; and (c) launches a fake JavaScript agent the same way (on Windows, through an npm `.cmd` shim). |
| D2 | Renderer security: the window has `contextIsolation`, `sandbox`, no `nodeIntegration` and the §2.1 CSP. In the renderer, `require` and `process` are undefined, a remote image in a lesson makes no request, and navigation and new windows are denied. IPC from any frame other than the main window's top frame is rejected. |
| D3 | Every IPC channel is declared in `shared/api.ts`. Each handler validates its input and calls one function. Unknown channels and bad input are rejected. |
| D4 | Canary test: an exercise whose solution, mutants, hidden tests and expected outputs hold canary strings is authored through a recorded author stream. Every IPC handler is driven, and every renderer-bound payload and the app log are checked: none holds a canary. A tutor reply that quotes a canary line is held back. |
| D5 | The bridge, for Claude Code and Codex: launch arguments match §3.1. Recorded streams parse to the expected events, and malformed lines produce none. A cancelled job reports `stopped: true` only after its whole process group is gone, including a child that ignores SIGTERM; a surviving group reports `stopped: false`. A job cancelled before it starts never spawns. Lines over the cap are dropped, with or without a newline. Sign-in answers at its deadline even when a child holds the pipe, and reads no more than its cap. No stdin, no shell. |
| D6 | Credentials: no desktop code reads agent credential files or credential environment variables. Sign-in returns a boolean only, and status output (for example, an email address) never reaches IPC or logs. |
| D7 | Install consent: with `--desktop`, `save_track` stores a proposal and builds nothing. Only `installProposal` builds, and only when the digest matches; a proposal whose files changed after the learner saw them is refused. Approving a roadmap never calls it. |
| D8 | Roadmap: `get_roadmap` round-trips. App edits keep ids. A move is refused when a topic would come before one it requires. Removing a required topic, or one used by an exercise, event or lesson, is refused. An uninstalled track gives `setup`. The track can change until the course has exercises or a lesson with runnable examples, and the change cancels the old track's jobs and proposals. Adding a prerequisite to a stuck concept records `retry`. Sources are validated, stored and returned. |
| D9 | Lessons: save, get, edit and notes work. `get_lesson` records nothing, and only `mark_lesson_read` records a read. A new agent save never overwrites a learner edit. The `lesson` field on `practice` and `author` steps is `null`, the earliest unread id, or absent, as §4.4 says. Writes are locked, atomic and versioned. |
| D10 | Skip and retry: skip defers without changing mastery and never satisfies a prerequisite. With every candidate deferred, the earliest is chosen. `done` needs every concept mastered. After `retry`, a concept that was stuck isn't stuck, and its mastery is unchanged. |
| D11 | `installProposal` emits ordered progress events without diagnostics. |
| D12 | Practice and assist: tutor turns launch with no edit tools (§3.1). An assist job runs only after the learner's yes and can edit only the exercise folder. The app can't switch exercises while it runs. Assist is off when it ends, whether it succeeds, fails or is cancelled, and startup clears it. |
| D13 | Bounds: with a fake agent, an author job is cancelled after 3 failed saves, every job stops at its deadline, a failed job is relaunched at most once, and the flow ends on a §5 screen. |
| D14 | *Journey*, on macOS with Docker Desktop, in the packaged app, for Claude Code and Codex: connect, goal, research, roadmap edit, approve, setup consent, lesson, a failing check, then a passing check, then the course view. Evidence goes in the release notes. |
| D15 | *Journey*, on Windows 11 (Docker Desktop, WSL2) and Ubuntu (Docker Engine): install the unsigned build, connect one agent and pass one activity. If it can't be run, the OS is marked experimental (O3). |
| D16 | *Journey*, Cursor: attempted. If it can't be signed in and run here, it is marked experimental and its connect row says so. |
| D17 | *Journey*, weak models: the D14 flow completes with at least one small model per verified agent (for example, Claude Haiku and gpt-6-luna). Bench evidence goes in the release notes. |
| D18 | UI rules: rendering every screen shows agent names only on the connect screen, the tutor named "Codemm", and no ids, versions, paths or timestamps. |
| D19 | No language dispatch: core A1's scan covers `desktop/`. Track names and colors come from `list_tracks` or the learner. |
| D20 | Failure states: each row in §5 maps to a tested screen state. A check with no runtime records nothing and shows "wasn't counted". |
| D21 | Jobs: switching the active course during an author job doesn't redirect its save. Each job's done check reads core records created after it started. A job whose save committed before a crash isn't relaunched. Cancelling during a check leaves no owned container behind. |
| D22 | `codemm mcp --tools a,b` lists and accepts only `a` and `b`. `--course` scopes course tools to that course. |
| D23 | Lesson gate: with the fixture track, a lesson whose two runnable examples have different source and output saves, each example running separately. A wrong output, a build error, a timeout or a sixth runnable block saves nothing and names the example. Runnable blocks are rejected before setup and on multi-file or unit-only tracks. A rebuild that changes an example's output fails and lists the lesson. A save racing a rebuild is checked on the image it is saved against. A course with runnable lessons can't change track. Docker down saves nothing. |
| D24 | Usage: every agent process exit produces exactly one usage record, with only the numbers the CLI gave, including failed and cancelled runs. A recorded resumed session is counted by difference. A topic that used both agents shows dollars and tokens separately, and "At least" when a run reported nothing. Reopening a saved lesson or activity starts no agent process. A torn last line is ignored. |
| D25 | CLI versions: `--version` output for each tested version parses to its full version token, and an untested one, including a prerelease of a tested version, shows the warning without blocking. CI parses every tested version's recorded streams. The live contract test exists and checks a tool-call turn, a resume and a cancel. |
| D26 | Minimum model: with `models.json` entries set, the connect row shows "Recommended: ‹model›" and Codex launches with `-m` and exactly that model. With `null`, neither happens. |
| D27 | Check this computer: with a fake runtime, a missing CLI, a stopped daemon and a failed network check each show only their row's fix, per OS. Fixing the fake makes the screen pass on its own within one re-check. With a slow probe, repeated focus events never start a second check. |
| D28 | *Beta*: the exit criteria in [beta-plan.md](beta-plan.md) pass before the public 1.0, and the results go in the release notes. |
| D29 | *Public release gate* (§7.1, decision 11): the macOS build is notarized, the Windows installer is signed, and electron-updater updates N to N+1 on each OS. Auto-update is off in unsigned builds (automated test). |

## 10. Test strategy

Work test-first. For each behavior, write a failing test, make it pass simply, then refactor while green.

- **Core first.** These are unit tests in:
  - `learner`: the lesson field, setup, skip and retry rules;
  - `schemas`: lessons, sources, predict blocks and runnable blocks;
  - `store`: proposals and digests, lessons, learner file replacement and atomicity;
  - `mcp`: `--tools` and `--course`;
  - `app`.
  Docker integration tests cover `installProposal` and its progress events.
- **Desktop main.** Pure modules get vitest tests: `agents` (launch, parse, usage and versions against recorded fixtures), `views` (the boundary and the reply filter), roadmap edit rules, job bounds and done checks, usage rounding, and the check-this-computer state machine.
- **The lesson gate** gets Docker integration tests with the POSIX-shell fixture track, like the exercise gates.
- **The bridge** is tested with fake agent scripts that replay recorded streams. CI never calls a real model. Fixtures are re-recorded when an agent CLI changes its stream, and [agent-bridge.md](agent-bridge.md) records the versions they come from.
- **Renderer.** A Playwright-for-Electron smoke test runs on each OS, plus the D2 security checks and a screen-text check for D18.
- **Journeys** D14 to D17 run by hand with real agents on the owner's subscriptions.

## 11. Delete or simplify

The desktop direction makes some existing core code and docs unnecessary. Each removal lands with the change that replaces it.

**Delete or rewrite with the change that replaces it:**

| What | Why | Replaced by |
|---|---|---|
| The rule that `skip` raises mastery to 0.85 (`learner.ts`, core §7) and "mark a concept you already know" in the CLI help | It reports mastery the learner never showed | §4.5 |
| The two long instruction blocks in `templates.ts` (`AGENTS_SECTION` and `AUTHOR_AGENT`) as the only source of agent rules | The app needs short per-job briefs; two copies of the rules would drift | one set of short job briefs in `templates.ts`; the terminal files are composed from them |
| "Any UI" in core §2 "Deferred" (the terminal practice-hook limitation for Codex and Cursor stays) | The app is in scope | this spec |
| README's terminal-first "Start learning" | The app is the main way in | an app-first README, with a short "Use from a terminal" section |
| "Human beta" in core §2 "Deferred" | The beta now comes before the public 1.0 | §1 release order and [beta-plan.md](beta-plan.md) |
| `spikes/agent-bridge/` | Throwaway proof | `desktop/src/main/agent/` (delete the spike in that PR) |

**Delete only if the app becomes the only way in (O7):**

| What | Size today |
|---|---|
| `init.ts` and `codemm init`, apart from writing `<ws>/.cursor/mcp.json` | 143 lines, plus A11 |
| `hook.ts` and `codemm hook claude` (the app's launch flags replace it) | 54 lines, plus A12 |
| The `codemm-author` subagent file (the app runs authoring as its own process) | part of `templates.ts` |
| The learner CLI commands `test`, `check`, `status`, `skip` and `assist` | thin wrappers; `app` keeps the logic |

The MCP server, `doctor`, `track add`, `track rebuild` and `tracks` stay either way. The app needs the server, and the rest support setup and repair.

## 12. Deferred

- Review scheduling: spacing intervals, priority over new topics and the authoring cost per review are product decisions, not a tiny rule. The prototype's review card is cut.
- Executable lesson previews, streaks and activity history.
- Windows and Linux arm64 builds. Signing and auto-update are decided in §7.1.
- Token-level streaming (Claude `--include-partial-messages`), a model picker, and signing in from inside the app.
- Colima, and Podman on macOS (after 1.0); Podman elsewhere in the app; multiple workspaces; course sharing.
- A Cursor stream parser, until Cursor is verified (D16).
- Stronger hidden-data protection against agents with file access, which would need a separate grader account or encrypted storage.
- A spend cap per job. §3.4 shows rough usage, but the CLIs don't report plan spend, so §3.2's time and retry bounds are the only limits.
- Practice hooks for terminal Codex and Cursor; protection there stays advisory (core §2).

## 13. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| O1 | Pass the agent the app's environment unchanged, or remove API-key variables so runs always use the signed-in plan | Pass it unchanged. Removing variables would break learners who use keys on purpose, and Codemm stays out of credentials. The connect line then shouldn't promise a plan: "Codemm uses your agent and your account." |
| O2 | Consent wording | Decided after the re-check: the honest line in §4.1 is required. |
| O3 | Windows and Linux: verified journeys before 1.0, or experimental as in core | Run D15 on real machines if available; otherwise experimental. |
| O4 | Lessons before activities for terminal users too (`next_step` changes for everyone) | Yes: one learner model, and `get_lesson` records reads in both. |
| O5 | Default workspace folder | `~/Codemm`, changeable in settings. A switch moves nothing: the new folder gets its own `codemm.json`, learner files are re-created there on demand (core §6), the old folder stays as it is, and tutor sessions start fresh. |
| O6 | Model choice. Codex jobs use the bench's recommended model when one is set, and Codex's default otherwise (§8). Claude Code jobs use the learner's default. Add a model setting? | No for 1.0. The bench picks the Codex model and checks the defaults, and a failure shows "Check your agent". |
| O7 | Keep the terminal path (`init`, the Claude hook, the author subagent, the learner CLI) in 1.0, or make the app the only way in and delete it (§11) | Keep it for 1.0: it is built, tested and journey-verified (A9 to A16), and the app shares its `app` functions. Revisit after D14. |
| O8 | Codex confinement | **Decided (a)** by the owner: the invariant is reworded (decision 10) and Codex ships with the reply filter. |
| O9 | The D29 signing gate | **Decided** by the owner: unsigned beta builds with open-anyway instructions; the public 1.0 is signed. |

## 14. Review log

**Astra (gpt-6-astra), desktop spec review, 17 Oct 2026.** Verdict: "not ready for implementation". All findings were accepted.

| Finding | Resolution |
|---|---|
| F1 blocker: job isolation not enforced | §3.1: `--tools ""` for Claude Code (canary test passed); Codex shell off and `enabled_tools`, with its remaining host tools stated; §4.8 per-job server `--tools`; §2.2 reply filter; O8 |
| F2 blocker: the spike blanket-approved the ordinary server | spike passes the job's tools as Codex `enabled_tools` and Claude `--tools ""`; agent-bridge.md finding 8 |
| F3 consent not bound to the files | §4.1 digest-addressed immutable proposals, re-checked under the track lock; new contents ask again; honest dialog text (O2) |
| F4 renderer content policy | §2.1 full CSP, remote images as links, `https:` links only, sender-frame checks; D2 |
| F5 job targets and done checks | §3.2 `--course` binding, per-job done checks against new records, reconcile before relaunch; §4.8; D21 |
| F6 cancellation didn't prove cleanup | spike resolves only after the group is gone, skips cancelled-before-start jobs, awaits `taskkill`, and treats a failed `pgrep` as unknown; §3.1 leftover-container cleanup; D5, D21 |
| F7 malformed or excessive output | spike validates event shapes, catches parser errors, caps lines, and bounds sign-in time and output; D5 |
| F8 skipping every candidate | §4.5 non-deferred first, otherwise the earliest deferred; D10 |
| F9 lesson completion for terminal users; removal | §4.4 `get_lesson` records the read; §4.2 lessons block removal |
| F10 assist left on | §3.2 assist job in the exercise folder; assist cleared when the turn ends and at startup; D12 |
| F11 editor persistence | §4.7 locked, digest-checked, symlink-safe replacement; read-only during assist |
| F12 packaged launch dependencies | §3.1 JavaScript launchers run with Electron as Node; `.cmd` shims resolved; D1 packaged checks |
| F13 overclaims; D17 | §8 restates the internal-consistency limit; D17 is a capability journey, and bounded failure is D13 |
| Earlier review 5: draft pins an uninstalled track | §4.2 track may change until the course has exercises |
| Earlier review 7: persistent stuck | §3.2 "Try an easier one" adds a prerequisite |
| Earlier review 8: research evidence and cost | §4.3 `version`, at least one source; §1 cost note and §3.2 bounds |

**Astra re-check, 17 Oct 2026.** F2, F3, F4, F8, F11, F12 and F13 were resolved. F1 stays open for Codex only, and O8 is required. Resolutions:

| Item | Resolution |
|---|---|
| F1 Codex isolation | Real tests (agent-bridge.md finding 7): the read-only sandbox lets the shell read files, so the shell is off; `--ignore-user-config` drops user MCP servers; `multi_agent` is off. Code mode can't be turned off without losing MCP tools, so confinement is unproven, and O8 asks the owner to choose. |
| F3 wording | §4.1 makes the honest consent line required; O2 is decided |
| F5 roadmap-change success | §3.2 the course record changed, or the result is an explicit "No change" |
| F6 cleanup not reported | spike reports `stopped`, checks the `taskkill` exit code; §3.1 failure message; D5 |
| F7 limits bypassed | spike drops overlong lines before parsing, slices sign-in output to the cap, settles sign-in at the deadline and stops the group; D5 |
| F10 assist across exercises | §3.2 no exercise switching during an assist turn; Stop clears assist; D12 |
| Earlier 7: stuck again after a prerequisite | §4.2 `retry` event appended when a prerequisite is added to a stuck concept; D8, D10 |
| Earlier 8: usage disclosure | §12 per-job usage display deferred; O1 connect wording |
| N1 fetching marks a lesson read | §4.4 `get_lesson` is pure; `mark_lesson_read` and `app.markLessonRead` acknowledge |
| N2 track switch with lessons | §4.2 the switch cancels old-track jobs and proposals. Lessons are kept rather than blocking the switch: they are editable static text that nothing runs or grades, and blocking would force a new course after any failed setup. |
| N3 practice-hook caveat | §11 keeps the terminal Codex and Cursor limitation; §12 |
| O5 workspace switch | §13 O5 defines it |

**Astra review of the owner-approved additions, 17 Oct 2026.** Verdict: "revise before implementation". All 13 findings were accepted:

| Finding | Resolution |
|---|---|
| A1 examples share one build | §4.4 each runnable example runs separately; D23 tests two different examples |
| A2 track switch with runnable lessons | §4.2 and §4.4: no track change once a runnable lesson exists; D8, D23 |
| A3 lesson save racing a rebuild | §4.4 track lock, then course lock, from validation through commit; D23 |
| A4 resumed Claude cost double-counted | §3.4 per-session difference, checked by the live contract test; D24 |
| A5 failed results dropped usage | spike keeps usage on failed results (test) |
| A6 runs with no `done`; mixed agents | §3.4 one record per process exit, recorded even with no numbers; dollars and tokens shown separately; "At least"; D24 |
| A7 contradictory signing rule | Decision 8, §7, §7.1: unsigned beta, D29 gates the public 1.0, waivable only under O9; D1 scoped to the beta |
| A8 beta consent and publication | beta-plan: handling stated before screening, an access and deletion contact, only aggregated publication, separate yes for quotations and screenshots |
| A9 prerelease versions | spike parses full version tokens (test); D25 |
| A10 overlapping checks | §6.1 one check at a time; D27 slow-probe test |
| A11 forced Codex model vs O6 | §8 "Recommended: ‹model›" and the exact `-m`; O6 rewritten; D26 |
| A12 exit criteria could never pass | beta-plan: a fixed-and-tested rule during the beta, plus a final validation window |
| A13 macOS 15 Gatekeeper | §7 and beta-plan: System Settings, Privacy & Security, Open Anyway, checked on a downloaded build |
