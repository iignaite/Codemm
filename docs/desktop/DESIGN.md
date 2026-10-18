# Codemm desktop 1.0 design

Status: trimmed to the owner-approved 1.0 scope (the scope ledger, 17 Oct 2026), after Astra's reviews (§14). It extends the core spec, `docs/DESIGN.md`, which stays authoritative for the harness. The core changes in §4 move into `docs/DESIGN.md` in the same PR as their code. The journeys follow the approved prototype (`codemm-journeys.html`, outside this repo). Agent CLI evidence: [agent-bridge.md](agent-bridge.md).

## Decisions

| # | Decision |
|---|---|
| 1 | 1.0 is the core harness plus an Electron app, published as downloadable installers on the public GitHub Releases page: a macOS `.dmg` for Apple Silicon and Intel, and a Windows installer. Codemm is bundled, so learners need no Node, npm or terminal. |
| 2 | The Electron main process calls core `app` functions in-process. The renderer reaches main only through a typed preload API whose handlers are thin and check their sender. |
| 3 | The renderer gets learner-safe data only: never solutions, mutants, hidden tests, expected outputs, author transcripts, tool arguments, agent stderr or debug logs. |
| 4 | "Codemm never calls a model" now reads: **Codemm launches the learner's own agent CLI. It never calls a model API, and it never reads, stores or asks for credentials.** |
| 5 | Each agent run is one job. A job has a short brief, a Codemm server bound to its course that exposes only that job's tools, the narrowest built-in tools the agent allows, a deadline, a retry bound and a check for whether it worked. Authoring runs in its own process and is never streamed. |
| 6 | Installing a track takes one consent, given in Codemm before setup. `save_track` only proposes a track, and Codemm builds exactly the files the learner approved. Approving a roadmap never installs anything. |
| 7 | New core features are the smallest the journey needs: a roadmap draft and edits, a `setup` step, static lessons with notes, honest skip, per-job servers and learner file saves. |
| 8 | Beta builds are unsigned and need one "Open anyway" step. The public 1.0 is signed (§7.1). |
| 9 | The app meets WCAG AA: full keyboard use, screen-reader labels and reduced motion. |
| 10 | **O8, decided by the owner:** the invariant now reads "Hidden data never leaves Codemm through Codemm's own outputs (tools, CLI, IPC and diagnostics). An agent with file access can read Codemm's files; Codemm removes that access where the agent allows." (`AGENTS.md`). Codex ships in the app with the reply filter (§2.2). |
| 11 | **O9, decided by the owner:** beta testers get unsigned builds with open-anyway instructions, and the public 1.0 is signed (D21). |

## 1. Scope

1.0 is the core harness (`docs/DESIGN.md`, A1 to A16) plus a desktop app that runs the prototype's journeys:

- **Connect:** Claude Code and Codex, with a sign-in check. Cursor is experimental.
- **Check this computer:** the environment matrix in §6.1.
- **Learn:**
  1. Pick a goal, and the agent writes a roadmap; it may research first.
  2. Approve the roadmap, ask for changes, or edit it: rename, reorder, add or remove topics.
  3. Give one consent before setup.
  4. Read lessons, which are static text, and take notes.
  5. Do the activity: edit, Try it, Check, and see the results.
  6. Ask the tutor, behind the reply filter.
  7. Skip honestly, and see progress and completion.
- **Failure states**, including the environment failures in §6.1.

The prototype's review card, streaks, predict questions, editable lessons and "Let Codemm edit" are deferred (§12). Environments come from `list_tracks`; nothing in the app is per-language.

**Release order:**

1. The Mac journey (D17) passes here.
2. A whole small course runs on the owner's Windows PC (D18).
3. A private beta runs with 5 to 10 learners, one course each ([beta-plan.md](beta-plan.md)).
4. The public 1.0 ships after the beta's exit criteria pass (D20), the build is signed (D21), and the owner approves.

**UI rules:**

- Use minimal wording.
- No status dots, arrows or metadata (ids, versions, paths or timestamps).
- Nothing should look like Claude's UI or copy Duolingo.
- The tutor and every action are "Codemm". Agent names (Claude Code, Codex, Cursor) appear only on the connect screen.
- The connect screen says "Codemm uses your agent and your plan." Every agent job starts from a learner action or the approved flow, and the bounds in §3.2 cap how much of the plan it uses.

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
    agent/agents.ts         per agent: launch arguments, stream parser, sign-in and version checks
    agent/bridge.ts         spawn, line parsing, cancellation, status commands (proved in spikes/agent-bridge)
    agent/jobs.ts           job kinds: brief, tools, deadline, retry bound, done check (§3.2)
  src/renderer/             screens only; no Node, no file or process access
```

- **Core in-process.** Main imports the core's `app` module from the repo and bundles it. `app` stays the only place that holds use cases, so the CLI, the MCP server and the app share them.
- **Two processes write course data.** These are main and the `codemm mcp` server that each agent job starts. The core's PID-based course, track and workspace locks already serialize them.
- **One server per job.** Each job's MCP server is the app's own binary in Node mode: `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/core/cli.js mcp --workspace <ws> --course <course> --tools <list> --desktop`. The Electron `RunAsNode` fuse must stay on.
- **One workspace.** The app keeps one workspace (default `~/Codemm`) holding `codemm.json` and `exercises/`. The course, events and tracks stay under `$CODEMM_HOME`, as in core. `desktop.json` carries `format_version` and is written atomically, like every Codemm-owned file.

### 2.1 Renderer security

- **Window settings.** Windows set `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and load the app's own `app://codemm` origin.
- **CSP.** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. The page can make no remote request, including for images.
- **Markdown.** Lessons and agent text are rendered with raw HTML stripped:
  - An image with a remote URL renders as a plain link.
  - Links keep only `https:` URLs.
  - Code blocks are highlighted, never run.
- **Navigation.** Navigation, `window.open` and webviews are denied. `shell.openExternal` opens a link only after a click, and only for `https:` URLs.
- **IPC senders.** Every handler checks that `event.senderFrame` is the main window's top frame on `app://codemm`, and rejects anything else.

### 2.2 The learner-safe boundary

- **IPC.** Every IPC result is built in `views.ts` from core results that are already learner-safe: `getExercise`, `CheckView`, `progress`, `getRoadmap`, `getLesson`, `listTracks`, and the learner file reads. Hidden results carry only an index and a status, as in core §4.2.
- **Agent events.** Only `text` events from tutor and roadmap-change turns reach the renderer. For other jobs the renderer sees a job state: `running`, `done` or `failed`.
- **Never forwarded.** Author, setup and lesson job streams, tool arguments and results, agent stderr, and status-command output.
- **Reply filter.** Before forwarding text, main compares it with the current exercise's solution, mutants, hidden tests and expected outputs. If any normalized line of at least 24 characters from that material appears verbatim, the message is replaced with "Codemm held back a reply that showed hidden material." This is a backstop, not proof: a paraphrase passes it.
- **Honor system.** As in core §1 and §4.2, grading is on the honor system, and hidden tests are hidden from the agent's tools, not from the computer. §3.1 says how much each agent can still read (decision 10).

## 3. The agent bridge

### 3.1 Launch, isolate, stream, cancel, sign in

Proved for Claude Code and Codex in [agent-bridge.md](agent-bridge.md). Cursor is unverified.

| | Claude Code | Codex | Cursor (experimental) |
|---|---|---|---|
| Headless turn | `claude -p <brief> --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check <brief>` | `cursor-agent -p --output-format stream-json --approve-mcps --workspace <ws>` |
| Codemm server | `--mcp-config <json> --strict-mcp-config` | `-c mcp_servers.codemm.{command,args,env}=…` | `<ws>/.cursor/mcp.json` (no flag exists) |
| Codemm tools | `--allowedTools mcp__codemm__<tool>,…` | `-c mcp_servers.codemm.enabled_tools=[…]`, then `default_tools_approval_mode="approve"` | `--approve-mcps` |
| Built-in tools | `--tools ""` (web search and fetch for the research job only) | `--ignore-user-config`, `--disable shell_tool --disable unified_exec --disable browser_use --disable computer_use --disable apps --disable multi_agent`, and `-c sandbox_mode="read-only"` | `--mode ask` |
| Follow-up turn | `--resume <session_id>` | `codex exec resume <thread_id>` | `--resume <chatId>` |
| Sign-in check | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in" | `cursor-agent status`, "Not logged in" |

**What isolation holds.** This was tested with a canary file the agent was asked to read (agent-bridge.md, finding 7).

- **Claude Code.** `--tools ""` leaves only the Codemm server's tools, with no shell and no file reads, and the canary wasn't read. The per-job `--tools` filter on the server (§4.6) narrows those to the job's own.
- **Codex.**
  - The read-only sandbox blocks writes and network, but not reads: with the shell on, `cat` of the canary succeeded. So the shell features are off.
  - `--ignore-user-config` drops the learner's own MCP servers and plugins. It also means Codex uses its default model, or the bench's recommendation (§8).
  - `enabled_tools` limits the Codemm tools, and `multi_agent` is off.
  - Code mode (`functions.exec`) remains, because Codex calls MCP tools through it. Whether it can read files is unproven. Hidden data is therefore protected by the reply filter and the honor system, under the reworded invariant (decision 10).
- **The invariant.** Codemm never runs agent-written code on the host, and runs untrusted code only through `sandbox.ts`. What the agent's own tools do happens under the agent's own sandbox, exactly as in a terminal. Turning those tools off is defense in depth.

**Running processes.**

- **Spawning.** Argument arrays, no shell, closed stdin (both CLIs otherwise wait on stdin), and each agent leads a new process group.
- **Cancelling.**
  - On POSIX: SIGTERM to the group, SIGKILL after 3 s, and the run resolves only when the group is gone.
  - On Windows: `taskkill /pid <pid> /t /f`, awaited.
  - A job that is already cancelled never starts.
  - If the group survives, or `taskkill` fails, the job fails with "Codemm couldn't stop your agent. Quit Codemm to stop it."
  - After a cancel or crash, main runs the core's leftover-container cleanup (`doctor --fix`'s rule: only containers whose owner is gone).
- **Robustness.**
  - A stream line that is malformed or makes the parser throw is skipped.
  - A line over 1 MB is dropped before parsing.
  - Status commands (sign-in, `--version`) stop at 10 s, even if a child keeps the pipe open, and read at most 64 KB.
- **Streaming.** Each stdout line is parsed into common events: `session`, `text`, `tool_call`, `tool_result` and `done`. Both CLIs emit whole messages, not tokens.

**Credentials and environment.**

- Codemm never opens an agent's credential files or keychain entries.
- Sign-in uses the agent's own status command. Only a yes or no leaves the bridge.
- Signing in is the learner's job in their agent ("Not signed in. Sign in to Codex first." then Try again).
- The agent gets the app's environment unchanged (decision O1).

**Finding and launching agents.**

- GUI apps don't load shell profiles. The app looks on `PATH` and in the usual install folders, and on the connect screen the learner can pick the agent's executable.
- A native executable runs directly.
- A JavaScript entry point (a `#!/usr/bin/env node` launcher, like the npm-installed Codex) runs as `ELECTRON_RUN_AS_NODE=1 <app executable> <script>`, so no system Node is needed.
- On Windows, an npm `.cmd` shim is never run, because that needs a shell. The app reads the script path from npm's fixed shim format and runs that script the same way.
- The same lookup adds Docker's folder to `PATH` for core calls.

### 3.2 Jobs

| Job | Codemm tools | Done when |
|---|---|---|
| Research and roadmap | `list_tracks`, `save_roadmap` | the job's course exists |
| Roadmap change ("Ask Codemm for changes") | `get_roadmap`, `save_roadmap` | the course record changed, or the turn ended without error and without a save (shown as "No change" with the agent's text) |
| Setup | `list_tracks`, `save_track` (proposes only) | a new proposal exists for the job's track |
| Lesson | `get_roadmap`, `save_lesson` | a new lesson exists for the job's concept |
| Author | `next_step`, `save_exercise` | a new exercise exists for the job's concept and difficulty |
| Tutor | `progress`, `next_step`, `get_exercise`, `get_lesson`, `mark_lesson_read`, `get_roadmap`, `list_tracks` | the turn ends without error |

- **Bound to a course.** Every job's server gets `--course <course>`, so switching courses in the app can't redirect a job's save.
- **Checking the result.** "Done when" is checked against core records created after the job started, never against the agent's text. Before relaunching a failed job, main checks again, because a save can commit just before a crash.
- **Fresh sessions.** Author, setup and lesson jobs start without history, which is cheaper and keeps the author's work out of the tutor's chat. The tutor resumes one session per course, from the same workspace folder, because both CLIs keep sessions per working directory.
- **Concurrency.** At most two agent processes run at once: one foreground job and one background queue. After approval, the first lesson runs in the foreground while setup, then authoring, runs in the background.
- **Bounds.**

  | Job | Deadline | Retry bound |
  |---|---|---|
  | Research | 10 min | — |
  | Setup | 10 min per proposal, then core's 10 min build limit | 3 proposals per setup |
  | Lesson | 5 min | 3 failed `save_lesson` calls |
  | Author | 15 min | 3 failed `save_exercise` calls |
  | Tutor | 5 min | — |

  The bridge counts failed saves from `tool_result` events and cancels the job at the bound. A failed job is relaunched once at most, and never when the failure is an infrastructure failure or a plan limit (§6.1). After that, the learner gets the failure screen (§5).
- **Practice protection.** Tutor turns have no edit tools in Claude Code or Codex. The learner edits; Codemm explains. This doesn't depend on the Claude hook, and it is not a security boundary (§3.1).
- **Stuck.**
  - "Reread the lesson" opens the lesson.
  - "Try an easier one" runs a roadmap-change job that adds a prerequisite topic. The stuck topic waits for it, then gets a fresh start (§4.2).
  - "Come back later" is skip (§4.4).

### 3.3 Agent CLI versions and the minimum model

- **Tested versions.** `agents.ts` lists the CLI versions the recorded fixtures come from: Claude Code 2.1.283 and Codex 0.156.1 so far, and none for Cursor.
- **Startup check.** At startup and on the connect screen, the app runs `<agent> --version` as a status command. A version not on the list, including a prerelease of a listed one, shows "Untested version. It may still work." on that agent's connect row. It never blocks.
- **Contract tests.** In CI, each tested version's recorded streams must parse to their expected events. A new version joins the list after a manual live run (the spike's `run` and `status`) records its streams as fixtures.
- **Model choice (O6).** `desktop/src/shared/models.json` lists the bench-tested models per agent (`docs/bench/results.md`) and marks the recommended one.
  - A connected agent's row shows a "Model" select with the recommended one preselected and marked "(recommended)". A disconnected row shows "Recommended: ‹model›". Cursor has no list.
  - The choice is saved in `desktop.json` as `models`. A saved model that is no longer on the list falls back to the recommended one.
  - Every job for that agent runs with the chosen model: `--model` for Claude Code and `-m` for Codex. Jobs therefore never depend on the learner's own default.

## 4. New core capabilities

Each addition lands in its own module (`schemas`, `store`, `learner`, `app`, `mcp`), with a thin MCP tool where the agent needs it.

### 4.1 One consent before setup

- **Proposals.** `codemm mcp --desktop` changes `save_track` only:
  1. It runs track gate 1: valid files, and `id@version` new or identical.
  2. It stores the files as an immutable proposal under `$CODEMM_HOME/proposals/<id>@<v>/<digest>/`. The digest is SHA-256 over the canonical file map.
  3. A newer proposal for the same `id@version` replaces older ones.
  4. It returns `{ proposed: "id@v" }` and the note "The learner decides in Codemm. End your turn."
  Writes are atomic and versioned and hold the track lock.
- **Installing.** The new `app.listProposals()`, `app.installProposal(ref, digest)` and `app.dropProposal(ref)` let main install a proposal.
  - Under the track lock, `installProposal` re-reads the files and recomputes the digest. It refuses unless the digest equals the one the learner was shown.
  - It then runs gates 2 to 5 and installs exactly like `saveTrack`.
- **The consent dialog.**
  - Text: "Set up React on this computer?" and "Setup runs code your agent wrote, with internet access. Graded runs are offline.", with Not now or Set up.
  - Details shows the Dockerfile and track.yaml, the 10-minute build limit, and the fact that builds have no memory or CPU limit.
- **Retries.**
  - **Build failure from the learner's machine.** If a build fails because the machine is offline or out of disk space (§6.1), nothing is recorded and no agent runs. Try again re-installs the same proposal, which needs no new consent because the digest is unchanged.
  - **Gate failure.** If the gates fail, a new setup job gets the gate diagnostics, which hold no learner secrets, and proposes again within the bound in §3.2. A new proposal has new contents, so it asks again: "Codemm has another way to set up React." with Stop or Set up.
- **Outside the app.** Without `--desktop`, `save_track` behaves as in core: approving the call in the agent is the consent.

### 4.2 Roadmap draft and edits

- **Draft before setup.**
  - `save_roadmap` accepts a track that isn't installed yet, if it is a valid `id@version`.
  - `next_step` returns `{ kind: "setup", track }` until it is installed.
  - Re-saving may change `track` while the course has no exercises, so a failed setup can move to another track. Before that save, main cancels the old track's setup and author jobs and drops its proposals. Lessons stay, because they are static text.
  - `save_exercise`, `get_exercise` and `check` still need the installed track.
  - If the installed track doesn't offer the roadmap's style, `next_step` fails with "Edit the roadmap's style".
- **Reading.** `get_roadmap` (tool) and `app.getRoadmap(ws)` return `{ course, goal, track, style, concepts: [{ id, title, requires }] }`.
- **Editing in the app** builds a new roadmap and saves it through `app.saveRoadmap`, so core §5 rules apply:
  - Rename changes the title only; the id stays stable.
  - Add creates an id from the title (kebab case, made unique) with `requires: []`.
  - Move changes order only. It is refused, with "Needs ‹title› first", when it would put a topic above one it requires. Move works without dragging.
  - Remove is refused when another topic requires it ("‹title› needs this topic"). Core also rejects removing a concept that an exercise, event or lesson uses; the lesson part is new. Prerequisites are never rewritten silently.
  - Prerequisite changes go through "Ask Codemm for changes".
- **A fresh start after a new prerequisite.** When a re-save adds a prerequisite to a concept that is stuck, `save_roadmap` appends `{ kind: "retry", at, concept }`. Replaying a `retry` resets that concept's fail streak and leaves mastery unchanged. Without it, the concept would be stuck again as soon as the new prerequisite was mastered.

### 4.3 Lessons

- **Saving.** `save_lesson { id, concept, title, markdown }`. The id is new in the course, the concept is in the roadmap, and the Markdown is at most 64 KB. Lessons are static text: nothing in them runs.
- **Storage.** `courses/<course>/lessons/<id>/` holds:
  - `lesson.json` (`format_version`, id, concept, title, created);
  - `lesson.md`, the agent's text, never changed after saving;
  - `notes.md`, the learner's notes.
  Writes are atomic and hold the course lock.
- **Reading.** `get_lesson { id }` and `app.getLesson` return the text and the notes and change nothing. Other app functions: `listLessons`, `saveNotes` and `markLessonRead`.
- **Caching.** Saved lessons are read from the course store. Reopening a lesson, or going back to an activity, starts no agent job.
- **Read events.** Only an acknowledgement records a read: `mark_lesson_read { id }` (tool) or `app.markLessonRead` appends `{ kind: "read", at, lesson, concept }` the first time.
  - The app calls it when the learner reaches the end of the lesson and clicks Next.
  - The terminal tutor calls it after the learner says they've read it.
  - An agent fetching a lesson for context never unlocks the activity.
- **Next step.** `practice` and `author` steps gain a `lesson` field:
  - `null`: the concept has no lesson yet (write one first).
  - an id: the earliest unread lesson.
  - absent: every lesson for the concept has been read.
  The activity stays locked, and the tutor teaches first, until the field is absent. The author job can still run in the background, because the step names the activity. Lessons never change mastery.
- **Not verified.** Lessons are checked for structure only; only activities are "checked before you see it".

### 4.4 Honest skip

`skip` now means "Come back later". It doesn't mean "I already know this".

- A `skip` event defers the concept without changing mastery.
- Candidates are still the concepts that aren't mastered and whose prerequisites are all mastered. A deferred concept never counts as a mastered prerequisite.
- Non-deferred candidates come first. If every candidate is deferred, the earliest in topological and roadmap order is chosen.
- The deferral ends at the concept's next check.
- `done` still needs every concept mastered.
- A `retry` event (§4.2) resets the concept's fail streak, so stuck ends without granting mastery.
- The CLI help changes to "come back to a concept later". 1.0 isn't published, so the change needs no migration.

### 4.5 Learner files

- **Reading.** `app.readLearnerFiles(ws, slug)` returns `{ path: { text, digest } }` for that exercise's track files only.
- **Saving.** `app.writeLearnerFile(ws, slug, path, text, digest)`:
  - holds the workspace lock;
  - accepts only that exercise's track files;
  - refuses any path whose components include a symlink;
  - replaces the file through a temp file and a rename;
  - refuses with "Changed outside Codemm" when the file's current digest isn't the one the editor loaded, and the editor reloads.
- **Try it and Check.** Try it calls `testExercise` (visible tests, not recorded), and Check calls `checkExercise` (recorded).

### 4.6 Per-job MCP server

`codemm mcp` gains two options:

- `--course <course>` makes course-scoped tools use that course instead of the workspace's active one.
- `--tools <list>` registers only the listed tools.

With neither option, the server behaves as in core.

### 4.7 Reviews

Core §7 schedules reviews of mastered concepts at 1, 3, 7, 21 and 60 days. In the app:

- **Due.** A due review shows as "Review" on the course map and the topic page, and the activity opens with a "Review" label. If no unused exercise fits, an author job writes one (`review: true`), shown as the review being written. A review comes due with time, not with a learner action, so reading the course starts that job when it isn't running (an exception to D9's "reads start nothing", which is about reopening saved work). The course map and topic page re-read the course when the window regains focus, and every 10 minutes once settled, so a review that came due while the app was open shows up.
- **Scheduled.** The mastery panel, and the completed-course screen, show "Review tomorrow" or "Review in N days" for a mastered topic. They never show dates. Overdue reviews wait their turn behind the one being offered, without a countdown.
- **Outcome.** A review is an ordinary Check. A pass keeps the topic mastered; a fail sends it back to practice.

### 4.8 Check progress

- **Core.** `testExercise` and `checkExercise` take an optional callback with `{ phase, done, total }` (core §4.2).
  - io reports each visible test as it finishes; the build, when the track has one, shows once as `building`.
  - Hidden tests and unit tests report their phase only (`total` 0): no names, counts or timing per hidden test.
- **Desktop.**
  - The renderer passes a run id with each Try it or Check. `live` tags that run's events with it and keeps only `phase`, `done` and `total`.
  - Main sends each event to the app's windows only, on the one-way channel `codemm:check-progress`.
  - The preload exposes it as `onCheckProgress(listener)`, which returns a function that stops listening. It isn't an IPC call: `invoke('onCheckProgress')` is refused.
- **Renderer.** While Try it or Check runs, the results panel shows a quiet bar with the phase and "3 of 8". With no count, it shows the phase alone. It hears only its own run's events, and stops listening when the learner leaves.

## 5. Failure states

Infrastructure failures record nothing. Learner-caused outcomes are graded as `error` and recorded (core §4.3, §7).

| What happened | What the learner sees | Recorded |
|---|---|---|
| Docker missing, not running, still starting, or stopped mid-session | "This check wasn't counted." and Check this computer (§6.1) | nothing |
| Offline or low disk during setup | "You're offline." or "Not enough disk space.", then Try again (§6.1) | nothing; no agent runs |
| Track image missing or changed | "Rebuild" on the track; runs `rebuildTrack` | nothing |
| No agent found, or signed out | the connect screen with its fix | nothing |
| Agent plan limit reached | "Your agent's plan limit is reached. Try again later." | nothing; no relaunch |
| Another agent failure (model refused, crash, deadline) or not done by its check | "Codemm couldn't finish that." Try again, or Check your agent (opens connect) | nothing; saves are atomic |
| Track gates fail | "Couldn't set up React." A new proposal asks again; after the bound, Stop or Try again | nothing |
| Author bound reached | "Couldn't write this activity." Try again | nothing |
| Editor file changed outside Codemm | the editor reloads it | nothing |
| A course is busy (lock) | a working state; core waits up to 10 minutes | nothing |
| Corrupt event log | "Codemm's records need a repair." with the doctor result | nothing |
| App quits or cancels during a job | agent process groups are killed, then leftover containers are cleaned up | nothing |
| Build error, timeout or output flood in learner code | the test results, as errors | a `check` event |

## 6. Platforms

| OS | Container runtime | 1.0 |
|---|---|---|
| macOS (Apple Silicon, Intel) | Docker Desktop | installer; journey D17 |
| Windows 11 x64 | Docker Desktop with the WSL 2 backend, set to Linux containers | installer; journey D18 |

- Core supports Linux and Windows (PR #16), including the container user on each platform, portable author paths and per-OS runtime help (`runtimeHelp` in `src/sandbox.ts`). Linux installers are deferred (§12).
- The app adds runtime and agent discovery (§3.1) and process-tree cancellation on Windows.

### 6.1 Check this computer

The first run, and every Docker or setup failure in §5, opens "Check this computer". It runs three rows in order, from core's `doctor` checks:

| Step | Passes when | While it fails |
|---|---|---|
| Docker is installed | the `docker` CLI is found (§3.1 lookup) | On macOS and Windows: **Install Docker**, which Codemm does for the learner (below), plus "Install it myself", linking to Docker's install page. On Linux: Docker Engine's install steps and link. |
| Docker is running | the daemon answers with Linux containers | A Docker that doesn't answer is stopped: "Open Docker Desktop, then wait until it says it is running.", with an **Open Docker Desktop** button on macOS and Windows. It is "Docker is starting. This can take a few minutes." only for the 3 minutes after Codemm itself opened or installed Docker, since Codemm can't tell a stopped daemon from a starting one otherwise. A Docker Desktop on Windows containers gets "Switch Docker Desktop to Linux containers." |
| The sandbox works | doctor's network check passes | "Codemm couldn't confirm the sandbox. Restart Docker and check again." |

- **Re-checking.** Only the first failing row shows its message. Only one check runs at a time: the next starts 5 seconds after the last finishes, or at once when the window regains focus and no check is running. Re-checking stops once every row passes, and Continue unlocks.
- **Docker stopping mid-session.** A check or setup that loses Docker fails as an infrastructure failure, records nothing, and opens this screen.
- **Docker's slow first start.** Setup and checks started while Docker is starting (in the 3 minutes after Codemm opened or installed it) wait for the daemon before failing, and record nothing. With a stopped Docker they fail at once as not counted.
- **Installing Docker Desktop for the learner** (`desktop/src/main/dockerDesktop.ts`). One click on Install Docker, on macOS and Windows:
  1. Codemm checks there is room (4 GB on macOS, 8 GB on Windows), then downloads Docker Desktop for this chip from `desktop.docker.com` over https. A redirect may only land on another https docker.com host.
  2. It runs the download only if Docker signed it:
     - macOS: `codesign --verify --deep --strict`, Docker's team id `9BNSXJN65R`, and `spctl --assess`;
     - Windows: `Get-AuthenticodeSignature` reports Valid, signed by `O=Docker Inc`. The path reaches PowerShell as an environment variable, never inside the command text.
     Otherwise it deletes the download and says so.
  3. macOS: Docker.app is copied to /Applications with `ditto` and opened. If the copy isn't allowed, the disk image opens in Finder for the learner to drag. Windows: Docker's installer runs with its own window, where Windows asks for permission.
  4. Codemm never accepts Docker's terms or asks for a password: Docker's own window does both on its first start, and the screen says so.
  5. The screen shows the download's progress, then each step. A stop says why: offline, low disk, not signed by Docker, Windows needs a restart, or the installer didn't finish. Every command is an argument array, and the download is deleted afterwards.
- **Offline or low disk during setup.** These count as infrastructure failures: nothing is recorded and no agent attempt is spent.
  - **Disk.** Before building, `installProposal` checks that the volume holding `$CODEMM_HOME` has at least 5 GB free, failing with "Not enough disk space".
  - **Build output.** A failed build whose output matches a known offline or disk-full marker (for example "no space left on device", "could not resolve host" or "network is unreachable") is an infrastructure failure. Any other failed build is a gate failure.
  - **Try again** re-installs the same proposal (§4.1).
- **Agent problems.**
  - No agent found and signed out go to the connect screen.
  - A plan limit is recognized from the agent's `done` error, by known per-agent limit markers ("usage limit", "rate limit", HTTP 429). A plan limit is never relaunched and spends no retry. An unrecognized error is a generic failure.
  - The markers are recorded as fixtures the first time each one is seen; until then they are unverified.

## 7. Packaging and release

- **Installers.** electron-builder produces a dmg on macOS for both Apple Silicon and Intel, and an NSIS installer on Windows (x64).
- **Bundled core.** The core is bundled under resources, unpacked from asar. The MCP server runs as `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/core/cli.js mcp …` (§2), so the learner needs no Node, npm or terminal.
- **Release workflow.** On a version tag, CI builds both installers and attaches them to a draft GitHub Release. Only the owner publishes it. No pull request publishes anything.
- **Unsigned for the beta.**
  - On macOS 15 and later: open the app once, then choose System Settings, Privacy & Security, Open Anyway. Right-click and Open no longer works for unnotarized apps.
  - On Windows, SmartScreen needs More info, then Run anyway.
  - [beta-plan.md](beta-plan.md) carries these instructions.

### 7.1 Signing (decision)

**Decision (O9).** Beta builds stay unsigned. The public 1.0 is signed (D21): the macOS build is signed and notarized, and the Windows installer is signed. Auto-update comes later, with signing (§12).

**Owner accounts and rough costs** (check at purchase):

| Platform | What's needed | Rough cost |
|---|---|---|
| macOS | Apple Developer Program membership, a Developer ID Application certificate, and an App Store Connect API key for notarization | US$99 a year |
| Windows | Either Azure Artifact Signing (open to individuals only in the USA and Canada, and to organizations there or in the EU or the UK) or a cloud-signing OV certificate from a certificate authority | Azure: US$9.99 a month. OV certificate: roughly US$200 to $500 a year. |

**Owner steps:**

1. Join the Apple Developer Program, as an individual or as an organization with a D-U-N-S number.
2. Create a Developer ID Application certificate and export it as a `.p12` file. Create an App Store Connect API key.
3. Pick the Windows option you're eligible for and set up its signing account.
4. Add the GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, plus the Windows provider's credentials.
5. Publish the first signed draft release.

## 8. Cross-model robustness

The flow must work from weak to strong models.

- **Gates are the net.** Tracks, roadmaps and exercises reach the learner only after their gates pass. A weak model costs retries, not inconsistent activities. As core §1 says, gates prove internal consistency, not that a statement teaches the right thing.
- **Short, single-purpose briefs.** Each job brief is at most about 25 lines, and the job's server exposes only its own tools. Briefs live in core `templates.ts` and name no language.
- **No subagents needed.** The app runs authoring as its own process.
- **Specific errors and bounded retries.** Tool inputs are validated with specific messages that the agent can act on. Retries are bounded (§3.2), and each job's done check reads core records.
- **Bench.** The cross-model bench (`bench/`, `docs/bench`) supplies the minimum model per agent (§3.3).

## 9. Acceptance criteria

Each item is verified by an automated test unless marked *journey* or *release*. Tests use a fake Docker and a fake agent.

| # | Requirement |
|---|---|
| D1 | **Distribution.** On a version tag, the release workflow builds the macOS dmg (Apple Silicon and Intel) and the Windows installer and attaches them to a draft GitHub Release. On a macOS runner and a Windows runner, each with no Node or npm on `PATH`, the packaged app: launches to the welcome screen; starts the bundled `codemm mcp` through `ELECTRON_RUN_AS_NODE`, which a test client calls `list_tracks` on; and launches a fake JavaScript agent the same way, on Windows through an npm `.cmd` shim. |
| D2 | **Renderer security.** The window has `contextIsolation`, `sandbox`, no `nodeIntegration` and the §2.1 CSP. In the renderer, `require` and `process` are undefined, a remote image in a lesson makes no request, and navigation and new windows are denied. IPC from any frame other than the main window's top frame is rejected. |
| D3 | **IPC contract.** Every IPC channel is declared in `shared/api.ts`. Each handler validates its input and calls one function. Unknown channels and bad input are rejected. |
| D4 | **Learner-safe boundary.** An exercise whose solution, mutants, hidden tests and expected outputs hold canary strings is authored through a recorded author stream. Every IPC handler is driven, and no renderer-bound payload or app log holds a canary. A tutor reply that quotes a canary line is held back. |
| D5 | **Agent bridge.** For Claude Code and Codex: launch arguments match §3.1, and recorded streams parse to the expected events, while malformed lines produce none. A cancelled job resolves only after its whole process group is gone, including a child that ignores SIGTERM, and a job cancelled before it starts never spawns. Overlong lines are dropped. Status commands stop at their deadline and cap. There is no stdin and no shell. No desktop code reads credential files or variables, and sign-in output (for example, an email address) never reaches IPC or logs. |
| D6 | **Versions and the minimum model.** Each tested version's `--version` output parses to its full token. An untested version, including a prerelease, shows the warning and doesn't block. A connected agent offers only its bench-tested models, with the recommended one preselected. The choice is saved in `desktop.json`, and every job for that agent launches with it (`--model` or `-m`). A model that isn't on the list is refused. |
| D7 | **One consent.** With `--desktop`, `save_track` stores a proposal and builds nothing. Only `installProposal` builds, and only when the digest matches; a proposal whose files changed after the learner saw them is refused. Approving a roadmap never builds. |
| D8 | **Roadmap.** `get_roadmap` round-trips. Rename, add, move and remove keep ids. A move is refused when a topic would come before one it requires, and a remove is refused for a required topic or one used by an exercise, event or lesson. An uninstalled track gives `setup`. The track can change until the course has exercises, and the change cancels the old track's jobs and proposals. Adding a prerequisite to a stuck concept records `retry`. |
| D9 | **Lessons.** Save, get and notes work, and writes are locked, atomic and versioned. `get_lesson` records nothing; only `mark_lesson_read` records a read. The `lesson` field on `practice` and `author` steps is `null`, the earliest unread id, or absent, as §4.3 says. Reopening a saved lesson or activity starts no agent process. |
| D10 | **Skip.** Skip defers without changing mastery and never satisfies a prerequisite. With every candidate deferred, the earliest is chosen. `done` needs every concept mastered. After `retry`, a concept that was stuck isn't stuck, and its mastery is unchanged. |
| D11 | **Activity.** A save with a stale digest is refused, and one through a symlinked path is refused. Try it records nothing. Check of edited files that completes grading records one attempt; core §7's exceptions hold, so a check of unchanged starter files or an infrastructure failure records nothing. Tutor turns launch with no edit tools. |
| D12 | **Jobs.** `codemm mcp --tools a,b` lists and accepts only `a` and `b`, and `--course` scopes course tools. Switching courses during an author job doesn't redirect its save. Done checks read records created after the job started, and a job whose save committed before a crash isn't relaunched. An author job is cancelled after 3 failed saves. Every job stops at its deadline, and a failed job is relaunched at most once. Cancelling during a check leaves no owned container behind. |
| D13 | **Check this computer and the environment matrix.** With the fake Docker and fake agent, each case shows its message and records nothing: missing Docker; not running; still starting (the starting message for 3 minutes after Codemm opened Docker, then the fix); installing Docker for the learner, including a download not signed by Docker; Windows containers; stopping mid-check; offline during setup; low disk during setup; no agent; signed out; plan limit. Offline, low disk and plan limit spend no agent retry. For the Docker cases, fixing the fake makes the screen pass on its own within one re-check, and repeated focus events never start a second check. The setup cases recover through Try again on the same proposal, and the agent cases through the connect screen. |
| D14 | **Failure states.** Each row in §5 maps to a tested screen state. |
| D15 | **UI rules and no language dispatch.** Rendering every screen shows agent names only on the connect screen, the tutor named "Codemm", and no ids, versions, paths or timestamps. Core A1's scan covers `desktop/`, and track names and colors come from `list_tracks` or the learner. |
| D16 | **Accessibility (WCAG AA).** Every journey screen passes an automated accessibility check with no AA violations, and every control has a screen-reader name. The D17 flow completes with the keyboard alone. With reduced motion set, nothing animates. |
| D17 | *Journey*, on macOS with Docker Desktop, in the packaged app, for Claude Code and Codex: connect, Check this computer, goal, roadmap edit, approve, setup consent, lesson with a note, a failing check, a passing check, skip, and the course view. |
| D18 | *Journey*, on the owner's Windows PC, from the downloaded installer: a whole small course, from connect to course complete. |
| D19 | *Journey*, Cursor: attempted. If it can't be signed in and run, its connect row says it is experimental. |
| D20 | *Release*: the beta exit criteria in [beta-plan.md](beta-plan.md) pass before the public 1.0. |
| D21 | *Release*: the public 1.0 is signed. The macOS build passes notarization (`spctl -a -vv` accepts it), and the Windows installer passes `signtool verify /pa`. |

## 10. Test strategy

Work test-first. For each behavior, write a failing test, make it pass simply, then refactor while green.

- **Core first.** Unit tests in:
  - `learner`: the lesson field, setup, skip and retry rules;
  - `schemas`: lessons;
  - `store`: proposals and digests, lessons and notes, learner file replacement and atomicity;
  - `mcp`: `--tools` and `--course`;
  - `app`.
  Docker integration tests cover `installProposal`, the disk check and build-failure classification.
- **Desktop main.** Pure modules get vitest tests: `agents` (launch, parse and versions against recorded fixtures), `views` (the boundary and the reply filter), roadmap edit rules, job bounds and done checks, plan-limit classification, and the check-this-computer state machine.
- **Fakes.** A fake Docker covers the environment matrix (D13), and fake agent scripts replay recorded streams. CI never calls a real model or needs real Docker for desktop tests.
- **Renderer.** A Playwright-for-Electron smoke test runs on macOS and Windows, with the D2 security checks, the D15 screen-text check and the D16 accessibility check.
- **Journeys.** D17 to D19 run by hand with real agents on the owner's subscriptions.

## 11. Delete or simplify

**Delete or rewrite with the change that replaces it:**

| What | Why | Replaced by |
|---|---|---|
| The rule that `skip` raises mastery to 0.85 (`learner.ts`, core §7) and "mark a concept you already know" in the CLI help | It reports mastery the learner never showed | §4.4 |
| The two long instruction blocks in `templates.ts` (`AGENTS_SECTION` and `AUTHOR_AGENT`) as the only source of agent rules | The app needs short per-job briefs; two copies would drift | one set of short job briefs; the terminal files are composed from them |
| "Any UI" and "Human beta" in core §2 "Deferred" (the terminal practice-hook limitation for Codex and Cursor stays) | The app and the beta are in scope | this spec and [beta-plan.md](beta-plan.md) |
| README's terminal-first "Start learning" | The app is the main way in | an app-first README, with a short "Use from a terminal" section |
| `spikes/agent-bridge/` | Throwaway proof | `desktop/src/main/agent/` (delete the spike in that PR, keeping its fixtures as the contract tests) |

**Delete only if the app becomes the only way in (O7):** `init.ts` and `codemm init` (apart from writing `<ws>/.cursor/mcp.json`), `hook.ts`, the `codemm-author` subagent file, and the learner CLI commands. The MCP server, `doctor` and the track commands stay either way.

## 12. Deferred

Cut from 1.0 by the owner's scope ledger:

- **Lessons:** running code examples in the sandbox (the lesson gate), predict questions, and learner edits of lesson text. Notes stay.
- **Usage:** recording agent usage and showing cost per topic. Lesson caching stays (§4.3).
- **Auto-update:** electron-updater on GitHub Releases, enabled only once builds are signed (macOS updates need a signed app).
- The prototype's review card, streaks and activity history. (Review scheduling itself is in 1.0: core §7.)
- **Research sources:** storing and showing the agent's sources with the roadmap. The agent may still research before writing it.
- **Progress:** streaming install (setup) progress. Setup and jobs show `running`, `done` or `failed`; checks stream progress (§4.8).
- **Assist:** a separate assist-edit job ("Let Codemm edit?"). The tutor explains, and the learner edits.
- **Platforms:** Linux installers, Windows and Linux arm64, Colima, and Podman.
- **Cursor** beyond experimental, and its stream parser.
- **Reviews:** the six-pass review, replaced by one Astra review plus re-checks.

Also deferred:

- Token-level streaming, a model picker, signing in from inside the app, multiple workspaces and course sharing.
- Stronger hidden-data protection against agents with file access, which would need a separate grader account or encrypted storage.
- Practice hooks for terminal Codex and Cursor; protection there stays advisory (core §2).

## 13. Owner decisions

| # | Decision | Decided |
|---|---|---|
| O1 | Pass the agent the app's environment unchanged, or remove API-key variables so runs always use the signed-in plan | Unchanged. Removing variables breaks learners who use keys on purpose, and Codemm stays out of credentials. The connect line then says "Codemm uses your agent and your account." |
| O5 | Default workspace folder | `~/Codemm`, changeable in settings. A switch moves nothing: the new folder gets its own `codemm.json`, learner files are re-created on demand, and tutor sessions start fresh. |
| O6 | Model choice | Yes: a per-agent model choice of bench-tested models, with the recommended one preselected (§3.3). The owner reversed the earlier "no" on 18 Oct 2026. |
| O7 | Keep the terminal path in 1.0, or make the app the only way in (§11) | Keep it for 1.0: it is built, tested and journey-verified (A9 to A16). Revisit after D17. |

The owner accepted the recommendations for O1, O5 and O7 (the scope ledger, 17 Oct 2026). Also decided: O2 (the honest consent line, §4.1), O3 (macOS and Windows installers, Linux deferred), O4 (lessons before activities for everyone), O8 (decision 10) and O9 (decision 11).

## 14. Review log

D, F and A numbers and section references (§) in the entries below refer to the drafts they reviewed. The spec was renumbered when it was trimmed.

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

**Astra re-check of the scope trim, 17 Oct 2026.** The keep and cut lists match the ledger. Five gaps, all fixed:

| Finding | Resolution |
|---|---|
| T1 Check always records | D11 keeps core §7's exceptions (unchanged starter, infrastructure failure) |
| T2 automatic recovery overstated | D13: only the Docker cases recover by re-check; setup uses Try again, and agent cases use the connect screen |
| T3 minimum model could stay empty | D6: both entries are filled from the bench before the beta; `null` is for development only |
| T4 portability overstated | `docs/DESIGN.md` §3 states exactly what `assertPortablePaths` rejects |
| T5 dangling section reference | agent-bridge.md cites §4.6; the review-log note covers old section numbers |
