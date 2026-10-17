# Codemm desktop 1.0 design

Status: draft for review. It extends the core spec, `docs/DESIGN.md`, which stays authoritative for the harness. The core changes in §4 move into `docs/DESIGN.md` in the same PR as their code. The journeys follow the approved prototype (`codemm-journeys.html`, outside this repo). Agent CLI evidence: [agent-bridge.md](agent-bridge.md).

## Decisions

| # | Decision |
|---|---|
| 1 | 1.0 ships the core harness plus an Electron app for macOS, Windows and Linux. |
| 2 | The Electron main process calls core `app` functions in-process. The renderer reaches main only through a typed preload API whose handlers are thin. |
| 3 | The renderer gets learner-safe data only: never solutions, mutants, hidden tests, expected outputs, author transcripts, tool arguments, agent stderr or debug logs. |
| 4 | "Codemm never calls a model" now reads: **Codemm launches the learner's own agent CLI. It never calls a model API, and it never reads, stores or asks for credentials.** |
| 5 | Each agent run is one job with a short brief, only that job's Codemm tools, an explicit permission level, a deadline and a retry bound. Authoring runs in its own process and is never streamed. |
| 6 | Installing a track stays its own decision. In the app, `save_track` only proposes a track. Codemm builds it after the learner clicks Set up, never on roadmap approval. |
| 7 | New core features are the smallest needed: lessons, roadmap read, research sources, a `lesson` and a `setup` step, honest skip, and install progress events. Review scheduling is deferred. |
| 8 | Installers are built with electron-builder and are unsigned for 1.0. |

## 1. Scope

1.0 is the core harness (`docs/DESIGN.md`, A1 to A16) plus a desktop app that runs the six journeys in the prototype: connect, learn anything, lessons, activities, course, and failure states.

Changes from the prototype, following Astra's design review:

- "Best path" becomes "Suggested path".
- Lessons hold static examples and predict questions. Agent-written code never runs in the app.
- The review card and streaks are cut (deferred, §11).
- Environments come from `list_tracks`. Nothing in the app is per-language.

UI rules:

- Use minimal wording.
- No status dots, arrows or metadata (ids, versions, paths or timestamps).
- Nothing should look like Claude's UI or copy Duolingo.
- The tutor and every action are "Codemm". Agent names (Claude Code, Codex, Cursor) appear only on the connect screen. The connect screen carries the disclosure "Codemm uses your agent and your plan."

## 2. Architecture

```
desktop/
  src/shared/api.ts         the IPC contract: channel names, input and output types
  src/preload/preload.ts    contextBridge exposes `codemm.*` from api.ts; nothing else
  src/main/
    main.ts                 window, app lifecycle, menu
    ipc.ts                  one handler per channel: validate input, call one function, return a view
    views.ts                learner-safe projections of core results (the boundary in §2.2)
    state.ts                desktop.json in userData: chosen agent, binary path, tutor session id
    agent/agents.ts         per agent: launch arguments, stream parser, sign-in check
    agent/bridge.ts         spawn, line parsing, cancellation, sign-in (proved in spikes/agent-bridge)
    agent/jobs.ts           job kinds: brief, tools, permissions, deadline, retry bound (§3.2)
  src/renderer/             screens only; no Node, no file or process access
```

- **Core in-process.** Main imports the core's `app` module from the repo and bundles it. `app` stays the only place that holds use cases, so the CLI, the MCP server and the app share them.
- **Two processes write course data.** These are main and the `codemm mcp` server that the agent starts. The core's PID-based course and track locks already serialize them.
- **The MCP server** is the app's own binary in Node mode: `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/core/cli.js mcp --workspace <ws> --desktop`. The Electron `RunAsNode` fuse must stay on.
- **One workspace.** The app keeps one workspace (default `~/Codemm`) holding `codemm.json` and `exercises/`. The course, events and tracks stay under `$CODEMM_HOME`, as in core. `desktop.json` carries `format_version` and is written atomically, like every Codemm-owned file.

### 2.1 Renderer security

- Windows set `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and use a strict CSP with no remote code.
- Navigation and `window.open` are denied. A link is opened by `shell.openExternal` only after a click, and only for `https:` URLs.
- Lessons and agent text are Markdown rendered with raw HTML stripped. Code blocks are highlighted, never run.

### 2.2 The learner-safe boundary

- **IPC.** Every IPC result is built in `views.ts` from core results that are already learner-safe: `getExercise`, `CheckView`, `progress`, `getRoadmap`, `getLesson`, `listTracks`, and the learner file reads. Hidden results carry only an index and a status, as in core §4.2.
- **Agent events.** Only `text` events from tutor turns reach the renderer. For other jobs the renderer sees a job state (`running`, `checking`, `retrying`, `done`, `failed`).
- **Never forwarded.** Author, setup and lesson job streams, tool arguments and results, agent stderr, and sign-in output.
- **Test.** A canary test enforces this (D4).

## 3. The agent bridge

### 3.1 Launch, stream, cancel, sign in

Proved for Claude Code and Codex in [agent-bridge.md](agent-bridge.md). Cursor is unverified.

| | Claude Code | Codex | Cursor (unverified) |
|---|---|---|---|
| Headless turn | `claude -p <brief> --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check <brief>` | `cursor-agent -p --output-format stream-json --approve-mcps --workspace <ws>` |
| Codemm server | `--mcp-config <json> --strict-mcp-config` | `-c mcp_servers.codemm.{command,args,env}=…` | `<ws>/.cursor/mcp.json` (no flag exists) |
| Tool permission | `--allowedTools mcp__codemm__<tool>,…` | `-c mcp_servers.codemm.default_tools_approval_mode="approve"` | `--approve-mcps` |
| Read-only turn | `--permission-mode default --disallowedTools Edit,Write,MultiEdit,NotebookEdit,Bash` | `-c sandbox_mode="read-only"` | `--mode ask` |
| Follow-up turn | `--resume <session_id>` | `codex exec resume <thread_id>` | `--resume <chatId>` |
| Sign-in check | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in" | `cursor-agent status`, "Not logged in" |

- **Processes.** Argument arrays, no shell, stdin closed (both CLIs otherwise wait on stdin), and a new process group. Cancelling kills the group on POSIX and runs `taskkill /pid <pid> /t /f` on Windows, so the agent's MCP server and tools stop too.
- **Streaming.** Each stdout line is parsed into common events: `session`, `text`, `tool_call`, `tool_result` and `done`. Both CLIs emit whole messages, not tokens, so the panel shows a working state until each message arrives.
- **Credentials.** Codemm never opens an agent's credential files or keychain entries. Sign-in uses the agent's own status command. Only a yes or no leaves the bridge, and the output is dropped. Signing in is the learner's job in their agent ("Not signed in. Sign in to Codex first." then Try again).
- **Environment.** The agent gets the app's environment unchanged. Codemm adds and removes nothing (open decision O1).
- **Finding agents.** GUI apps don't load shell profiles. The app looks on `PATH` and in the usual install folders. On the connect screen the learner can pick the agent's executable, which is needed for version-manager installs. On Windows the app runs `.exe` files only, because `.cmd` shims need a shell.
- **Docker.** The same lookup adds Docker's folder to `PATH` for core calls.

### 3.2 Jobs

| Job | Codemm tools | Other tools | Permission | Shown to the learner |
|---|---|---|---|---|
| Research and roadmap | `list_tracks`, `save_roadmap` | web search and fetch | read-only | state, then the saved roadmap and sources |
| Roadmap change ("Ask Codemm for changes") | `get_roadmap`, `save_roadmap` | none | read-only | state, then the saved roadmap |
| Setup | `list_tracks`, `save_track` (proposes only) | none | read-only | state, then the consent dialog |
| Lesson | `get_roadmap`, `save_lesson` | none | read-only | state, then the lesson |
| Author | `next_step`, `save_exercise` | none | read-only | state only; the result is an exercise id from core state |
| Tutor | `progress`, `next_step`, `get_exercise`, `get_lesson`, `get_roadmap`, `list_tracks` | none | read-only | text |
| Assist | tutor tools | file edits | write, only after the learner's yes | text |

- **Fresh sessions.** Author, setup and lesson jobs start without history. They are cheaper, and an author job can't see the tutor's chat (or the tutor the author's). The tutor resumes one session per course.
- **Concurrency.** At most two agent processes run at once: one foreground job and one background queue. After approval, the first lesson runs in the foreground while setup, then authoring, runs in the background ("Reading starts as soon as the first lesson exists").
- **Success comes from core state.** A job succeeds when the record exists: the course, a proposal, a lesson, or an exercise for that concept and difficulty. The agent's text never decides success.
- **Bounds.**

  | Job | Deadline | Retry bound |
  |---|---|---|
  | Research | 10 min | — |
  | Setup | 10 min per proposal, then core's 10 min build limit | 3 proposals per setup |
  | Lesson | 5 min | — |
  | Author | 15 min | 3 failed `save_exercise` calls |
  | Tutor | 5 min | — |

  The bridge counts failed saves from `tool_result` events and cancels the job at the bound. A failed job is relaunched once at most. After that, the learner gets the failure screen (§5).
- **Practice protection is enforced by launch flags.** Tutor turns can't edit files in Claude Code or Codex. This doesn't depend on the Claude hook, and it is still not a security boundary (the agent can read `~/.codemm`, as in core). "Let Codemm edit?" runs `app.setAssist(ws, true)`, then one assist turn, the learner's check, then `app.setAssist(ws, false)`. Core §7 rules are unchanged: the attempt counts a quarter, the exercise stays assisted, and a new exercise follows because the concept isn't mastered yet.

## 4. New core capabilities

Each addition lands in its own module (`schemas`, `store`, `learner`, `app`), with a thin MCP tool where the agent needs it.

### 4.1 Install consent in the app

- `codemm mcp --desktop` changes `save_track` only. It runs track gate 1 (valid files, and `id@version` new or identical) and stores the files as a proposal under `$CODEMM_HOME/proposals/<id>@<v>/`. The write is atomic and versioned and holds the track lock. It returns `{ proposed: "id@v" }` and the note "The learner decides in Codemm. End your turn."
- The new `app.listProposals()`, `app.installProposal(ref, onProgress)` and `app.dropProposal(ref)` let main install a proposal. `installProposal` runs gates 2 to 5 and installs exactly like `saveTrack`.
- The consent dialog reads "Set up React on this computer?" with "Downloads once. Graded runs are offline." and Not now or Set up. Details shows the Dockerfile and track.yaml as text.
- If a build fails, a new setup job gets the gate diagnostics (track diagnostics hold no learner secrets) and proposes again, within the bound in §3.2. Whether one consent covers those retries is open decision O2. The default is that it does, the learner can Stop at any time, and every attempt uses a fresh build context without secrets.
- Roadmap approval never installs anything. Without `--desktop`, `save_track` behaves as in core: approving the call in the agent is the consent.

### 4.2 Roadmap read and edit

- **Draft before setup.** `save_roadmap` accepts a track that isn't installed yet, if it is a valid `id@version`. `next_step` returns `{ kind: "setup", track }` until it is installed. `save_exercise`, `get_exercise` and `check` still need the installed track. If the installed track doesn't offer the roadmap's style, `next_step` fails with "Edit the roadmap's style".
- **Reading.** `get_roadmap` (tool) and `app.getRoadmap(ws)` return `{ course, goal, track, style, concepts: [{ id, title, requires }], sources }`.
- **Editing in the app** builds a new roadmap and saves it through `app.saveRoadmap`, so core §5 rules apply unchanged:
  - Rename changes the title only, and the id stays stable.
  - Add creates an id from the title (kebab case, made unique) with `requires: []`.
  - Move changes order only. It is refused, with "Needs ‹title› first", when it would put a topic above one it requires.
  - Remove is refused when another topic requires it ("‹title› needs this topic") or core rejects it (used by an exercise or event). Prerequisites are never rewritten silently.
  - Prerequisite changes go through "Ask Codemm for changes".

### 4.3 Research sources

- `save_roadmap` takes optional `sources: [{ url, title, retrieved, why }]`:
  - 1 to 20 entries;
  - `https:` URLs only;
  - `retrieved` as `YYYY-MM-DD`;
  - `title` up to 120 characters, `why` up to 280.
- Sources are stored in `course.json` and returned by `get_roadmap`.
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
- **Storage.** `courses/<course>/lessons/<id>/` holds:
  - `lesson.json` (`format_version`, id, concept, title, created);
  - `lesson.md`, the agent's text, which is never changed after saving;
  - `edited.md`, the learner's version, which is shown instead when present;
  - `notes.md`, the learner's notes.
  Writes are atomic and hold the course lock.
- **Reading.** `get_lesson { id }` returns the shown text and the notes. App functions: `listLessons`, `getLesson`, `editLesson`, `saveNotes` and `readLesson`.
- **Read events.** `readLesson` appends `{ kind: "read", at, lesson, concept }` when the learner finishes a lesson.
- **Next step.** After the stuck check (core §7, step 3), if the chosen concept has no lesson, `next_step` returns `{ kind: "lesson", concept, lesson: null }` (write one). If it has an unread lesson, it returns `{ kind: "lesson", concept, lesson: id }` for the earliest unread one. Lessons never change mastery.
- **Not verified.** Lessons are checked for structure only. Only activities are "checked before you see it". The learner can edit a lesson or tell Codemm when it reads wrong.

### 4.5 Honest skip

`skip` now means "Come back later". It doesn't mean "I already know this".

- A `skip` event defers the concept without changing mastery.
- A deferred concept is not a candidate while any other candidate exists. It never satisfies a prerequisite.
- The deferral ends at the concept's next check, or when it is the only candidate left.
- `done` still needs every concept mastered.
- The CLI help changes to "come back to a concept later". 1.0 isn't published, so the change needs no migration.

### 4.6 Install progress events

`installProposal` and `saveTrack` take an optional `onProgress({ step, state })`. Steps are `build`, `pass-probe`, `fail-probe` and `repeat`. States are `running`, `passed` and `failed`. Events carry no diagnostics.

Exercise gates run in the agent's MCP server, so the app derives the author job's state from the stream instead: a `save_exercise` call means `checking`, and a failed result means `retrying`. No new channel is needed.

### 4.7 Learner files

`app.readLearnerFiles(ws, slug)` and `app.writeLearnerFile(ws, slug, path, text)` cover only the track's learner files for that exercise. They reuse core's symlink-safe, atomic workspace writes. The editor saves through them, Run tests calls `testExercise`, and Check calls `checkExercise`.

## 5. Failure states

Infrastructure failures record nothing. Learner-caused outcomes are graded as `error` and recorded (core §4.3, §7).

| What happened | What the learner sees | Recorded |
|---|---|---|
| Docker not running, or the host deadline passed | "This check wasn't counted. Docker isn't running. Start it, then try again." | nothing |
| Track image missing or changed | "Rebuild" on the track; runs `rebuildTrack` | nothing |
| No agent found, or not signed in | the connect screen with its fix | nothing |
| An agent run fails (model refused, rate limit, crash, deadline) or ends without its save | "Codemm couldn't finish that." Try again or Check your agent (opens connect) | nothing; saves are atomic |
| Track gates fail | "Couldn't set up React. Codemm is trying another way." Stop or Try now; after the bound, Stop or Try again | nothing |
| Author bound reached | "Couldn't write this activity." Try again | nothing |
| A course is busy (lock) | a working state; core waits up to 10 minutes | nothing |
| Corrupt event log | "Codemm's records need a repair." with the doctor result | nothing |
| App quits during a job | agent process groups are killed | nothing |
| Build error, timeout or output flood in learner code | the test results, as errors | a `check` event |

## 6. Cross-platform support

| OS | Container runtime | Status for 1.0 |
|---|---|---|
| macOS (arm64, x64) | Docker Desktop | verified, journey D14 |
| Windows 11 x64 | Docker Desktop with the WSL2 backend; the app runs natively and calls `docker.exe` | D15, otherwise experimental (O3) |
| Linux x64 | Docker Engine; the user must be in the `docker` group or run rootless | D15, otherwise experimental (O3) |

- Core cross-platform fixes and CI belong to the cross-platform core work. Core already omits `--user` outside POSIX.
- The app only adds runtime discovery (§3.1) and process-tree cancellation on Windows.

## 7. Packaging

- **Installers.** electron-builder produces a dmg and zip on macOS (arm64 and x64), NSIS on Windows (x64), and AppImage and deb on Linux (x64).
- **Bundled core.** The core is bundled under resources (unpacked from asar) for the MCP server.
- **Unsigned for 1.0.**
  - macOS needs a right-click and Open, or removing the quarantine attribute.
  - Windows SmartScreen needs More info, then Run anyway.
  - The README states both.
- **Later, with the owner's accounts.** Signing, notarization and auto-update need the owner's Apple Developer and Windows code-signing accounts, so they are deferred.
- **CI.** CI builds installers on all three OSes and keeps them as artifacts. Nothing is published.

## 8. Cross-model robustness

The flow must work from weak to strong models.

- **Gates are the net.** Tracks, roadmaps and exercises reach the learner only after their gates pass. A weak model costs retries, not wrong activities.
- **Short, single-purpose briefs.** Each job brief is at most about 25 lines and lists only that job's tools. In Claude Code, MCP tools load lazily through a ToolSearch step, so fewer tools means fewer wrong calls. Briefs live in core `templates.ts` and name no language.
- **No subagents needed.** The app runs authoring as its own process. Hosts or models that handle subagents poorly still get isolation.
- **Specific errors and bounded retries.** Tool inputs are validated with specific messages that the agent can act on. Retries are bounded (§3.2), and success comes from core state.
- **Bench.** The cross-model bench (`bench/`) supplies evidence per model. D17 requires the desktop flow to pass with one small model per verified agent, or to fail only into honest failure screens.

## 9. Acceptance criteria

Each item is verified by an automated test unless marked *journey*.

| # | Requirement |
|---|---|
| D1 | CI builds unsigned installers on macOS (dmg), Windows (NSIS) and Linux (AppImage, deb). A smoke test launches each build to the welcome screen. |
| D2 | Renderer isolation: the window has `contextIsolation`, `sandbox`, no `nodeIntegration` and a strict CSP. `require` and `process` are undefined in the renderer, and navigation and new windows are denied. |
| D3 | Every IPC channel is declared in `shared/api.ts`. Each handler validates its input and calls one function. Unknown channels and bad input are rejected. |
| D4 | Canary test: an exercise whose solution, mutants, hidden tests and expected outputs hold canary strings is authored through a recorded author stream. Every IPC handler is driven, and every renderer-bound payload and the app log are checked for the canaries. None appears. |
| D5 | The bridge, for Claude Code and Codex: launch arguments match §3.1. Recorded streams parse to the expected events. Cancelling leaves no process from the group. The agent gets no stdin, and no shell is used. |
| D6 | Credentials: no desktop code reads agent credential files or credential environment variables. Sign-in returns a boolean only, and status output (for example, an email address) never reaches IPC or logs. |
| D7 | Install consent: with `--desktop`, `save_track` stores a proposal and builds nothing. Only `installProposal` builds. Approving a roadmap never calls it. |
| D8 | Roadmap: `get_roadmap` round-trips. App edits keep ids. A move is refused when a prerequisite would follow its dependant. Removing a required or used topic is refused. An uninstalled track gives `setup`. Sources are validated, stored and returned. |
| D9 | Lessons: save, get, edit, notes and read work. A new agent save never overwrites a learner edit. `next_step` lesson rules hold. Writes are locked, atomic and versioned. |
| D10 | Skip: it defers without changing mastery. It never satisfies a prerequisite. The concept returns when it is the only candidate. `done` needs every concept mastered. |
| D11 | `installProposal` emits ordered progress events without diagnostics. |
| D12 | Practice protection: tutor turns launch with the read-only flags in §3.1. An assist turn runs only after the learner's yes, and assist is turned off after the assisted check. |
| D13 | Bounds: with a fake agent, an author job is cancelled after 3 failed saves, every job stops at its deadline, and a failed job is relaunched at most once. |
| D14 | *Journey*, on macOS with Docker Desktop, in the packaged app, for Claude Code and Codex: connect, goal, research, roadmap edit, approve, setup consent, lesson, a failing check, then a passing check, then the course view. Evidence goes in the release notes. |
| D15 | *Journey*, on Windows 11 (Docker Desktop, WSL2) and Ubuntu (Docker Engine): install the unsigned build, connect one agent and pass one activity. If it can't be run, the OS is marked experimental (O3). |
| D16 | *Journey*, Cursor: attempted. If it can't be signed in and run here, it is marked experimental and hidden behind its connect row. |
| D17 | *Journey*, weak models: D14 runs with Claude Haiku and a small Codex model. Each completes, or fails only into the §5 screens within the bounds, and never shows an unverified activity. |
| D18 | UI rules: rendering every screen shows agent names only on the connect screen, the tutor named "Codemm", and no ids, versions, paths or timestamps. |
| D19 | No language dispatch: core A1's scan covers `desktop/`. Track names and colors come from `list_tracks` or the learner. |
| D20 | Failure states: each row in §5 maps to a tested screen state. A check with no runtime records nothing and shows "wasn't counted". |

## 10. Test strategy

Work test-first. For each behavior, write a failing test, make it pass simply, then refactor while green.

- **Core first.** These are unit tests in `learner` (the lesson, setup and skip rules), `schemas` (lessons, sources, predict blocks), `store` (proposals, lessons, atomicity) and `app`. Docker integration tests cover `installProposal` and its progress events.
- **Desktop main.** Pure modules get vitest tests: `agents` (launch and parse against recorded fixtures), `views` (the boundary), roadmap edit rules and job bounds.
- **The bridge** is tested with fake agent scripts that replay recorded streams. CI never calls a real model. Fixtures are re-recorded when an agent CLI changes its stream, and [agent-bridge.md](agent-bridge.md) records the versions they come from.
- **Renderer.** A Playwright-for-Electron smoke test runs on each OS, plus a screen-text check for D18.
- **Journeys** D14 to D17 run by hand with real agents on the owner's subscriptions.

## 11. Deferred

- Review scheduling: spacing intervals, priority over new topics and the authoring cost per review are product decisions, not a tiny rule. The prototype's review card is cut.
- Executable lesson previews, streaks and activity history.
- Signing, notarization, auto-update, and Windows and Linux arm64 builds.
- Token-level streaming (Claude `--include-partial-messages`), a model picker, and signing in from inside the app.
- Podman in the app, multiple workspaces, and course sharing.
- A Cursor stream parser, until Cursor is verified (D16).

## 12. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| O1 | Pass the agent the app's environment unchanged, or remove API-key variables so runs always use the signed-in plan | Pass it unchanged. Removing variables would break learners who use keys on purpose, and Codemm stays out of credentials. |
| O2 | Does one setup consent cover up to 3 attempts for the same track, or does each attempt ask again? | One consent, with Stop always available and each attempt's files under Details. |
| O3 | Windows and Linux: verified journeys before 1.0, or experimental as in core | Run D15 on real machines if available; otherwise experimental. |
| O4 | Lessons before activities for terminal users too (`next_step` changes for everyone) | Yes: one learner model. |
| O5 | Default workspace folder | `~/Codemm`, changeable once in settings. |
| O6 | When the agent's own default model fails (seen with Codex), add a model setting? | No for 1.0. Show "Check your agent" and let the learner fix it in the agent. |
