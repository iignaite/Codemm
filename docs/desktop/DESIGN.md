# Codemm desktop 1.0 design

Status: revised after Astra's review (§15). This file extends `docs/DESIGN.md` (the core spec), which still governs everything it doesn't change. The screens follow the approved journey prototype (`codemm-journeys.html`), with Astra's design review of it applied. The agent bridge was proven with real agents; the evidence is in `docs/desktop/agent-bridge.md`.

## 1. Decisions

1. **1.0 is the core harness plus an Electron desktop app** for macOS, Windows and Linux. The CLI and MCP server keep working as they do today, apart from the additions in §5.
2. **The desktop drives the journey, and the agent does one small job per turn.** The app decides what happens next from Codemm's state. Each agent turn has a short prompt, a few tools, and a success check against Codemm's state, never against the agent's text. This is what makes weak models usable (§9).
3. **The app launches the learner's own agent CLI headless**: Claude Code, Codex, or Cursor. It gives the agent Codemm's MCP server and streams the replies into the Codemm panel.
4. **The invariant "Codemm never calls a model" now means:** Codemm launches the learner's agent, and never calls a model API itself. The second half, "never handles credentials", now means it never reads, stores or forwards them:
   - Codemm accepts only a subscription sign-in, as reported by the agent's own status command (O3). It also removes known API-key variables from the agent's environment and loads none of the user's agent settings (which could hold key helpers), so turns use the learner's own plan;
   - the core package (`src/`) still never starts an agent. Only `desktop/` does.
5. **Agents get only what a turn needs.** Every turn runs with Codemm's MCP server alone, none of the agent's file, shell or plugin tools, no user settings or hooks, and only the Codemm tools for that turn. The two exceptions: research turns also get web search, and assist turns get editing. This is enforced through each agent's own controls and verified for Claude Code and Codex (§3.4).
6. **Author work runs in separate, unseen agent sessions.** Installing a track and writing an exercise or lesson each run in a fresh session. The bridge drops that session's text, and only tool statuses and gate progress reach the screen. The tutor session never sees author work.
7. **The renderer is learner-safe by construction.** It receives only view types built in one main-process module. Solutions, mutants, hidden tests, expected hidden outputs, author text and agent error text never cross the preload bridge.
8. **Installing is its own decision.** Approving a roadmap never installs anything. The MCP server can install only the approved track, and only after the learner says yes (§5.4).
9. **Installers are unsigned for 1.0.** Signing and notarization wait for the owner's accounts.

## 2. Scope

**In 1.0:** the core (its guarantees unchanged), the desktop app, the core additions in §5, and the prototype's screens, with these changes from the review:

- **Names and wording.**
  - The tutor is always called **Codemm**; agent names appear only on the Connect screen.
  - The app stays monochrome until an agent is connected.
  - "Languages" becomes **Tracks**, filled from `list_tracks`; colors come from a hash of the track id, never from a table of names.
- **Research.** The result is labeled **Suggested path**. It shows sources only when the agent's search actually returned them (§5.3), and never claims they were read.
- **Setup.** It's a separate consent dialog. It says that setup runs the agent's install steps with internet access, and that graded runs have none.
- **Lessons.** Lessons show static examples, and nothing an agent writes runs in the app. A lesson counts as read only when the learner finishes it.
- **Getting unstuck.**
  - "Skip for now" becomes **Come back later**, which defers the topic without mastering it (§5.5).
  - **Try an easier one** and the activity that follows an assisted one are defined in §3.5.
- **Practice mode.** It says that the tutor can't edit the learner's code; §3.4 enforces this in every turn.

**Cut from 1.0 screens:** the Review card (spaced review is deferred), streaks and weekly activity, and executable lesson previews.

## 3. Architecture

```
renderer (React, sandboxed) ──preload: typed `codemm` API──▶ main process
                                                            ├─ ipc: validate, call, shape views
                                                            ├─ core `app` functions (in-process)
                                                            └─ agent bridge ──spawn──▶ agent CLI ──stdio──▶ codemm mcp
                                                                                                               └─ core `app`
```

### 3.1 Main process

- **It calls the core `app` functions directly**, in-process: `listTracks`, `saveRoadmap`, `getExercise`, `testExercise`, `checkExercise`, `progress`, `skip`, `setAssist`, `rebuildTrack`, and the §5 additions. Long operations already wait asynchronously on Docker, so the main thread stays responsive.
- **The agent's MCP server** is the bundled core CLI, run by Electron itself:
  - `command` is `process.execPath` and `env` has `ELECTRON_RUN_AS_NODE=1` and `CODEMM_HOME`, so learners don't need Node installed;
  - `args` are `[<resources>/core/cli.js, "mcp", "--workspace", <ws>, "--tools", <list>, "--progress", <file>]`, plus `--install <id@version>` in setup turns (§5.4).
- **Locks are shared.** The app and the agent's MCP server are separate processes that use the same PID-based course and track locks (core §10).
- **Settings** live in `settings.json` in Electron's userData folder, with `format_version`, written atomically: the chosen agent and model, the workspace folder, and the tutor session id per course.
- **The workspace** defaults to `~/Codemm`, and the learner can change it at first run.

### 3.2 Preload bridge and IPC

- **Window security:**
  - `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`;
  - a strict CSP with no remote origins;
  - navigation and `window.open` blocked;
  - links open in the system browser through `shell.openExternal`, and only for `https:` URLs.
- **The preload script** exposes one frozen object, `window.codemm`, typed in `src/shared/api.ts`. It never exposes `ipcRenderer`.
- **IPC handlers are thin:** validate the arguments with zod, call one core or bridge function, and return a view. They hold no logic.
- **`views.ts` is the only module that shapes data for the renderer.**
  - Each view type lists its fields explicitly, and nothing is spread from a core record.
  - Core's `CheckView` is already learner-safe.
  - `ExerciseView` comes from `getExercise`, including the learner files' current text (§5.7).
  - `LessonView`, `RoadmapView`, `AgentEvent` and `GateEvent` are new.

### 3.3 Module layout

The shell session owns the code. File names may change, but each responsibility lives in exactly one module.

```
desktop/
  electron-builder.yml
  src/
    shared/api.ts           the renderer contract: method signatures and view types
    preload/index.ts        exposes window.codemm, nothing else
    main/
      index.ts              app lifecycle, the window, security settings
      ipc.ts                thin handlers: validate → call → view
      views.ts              core results → learner-safe views
      flow.ts               pure: the next turn or screen, from Codemm state (§3.5)
      turns.ts              pure: each turn kind's prompt, tools and success check
      roadmap-edits.ts      pure: rename, move, add, remove → roadmap YAML
      settings.ts           settings.json
      progress.ts           reads a turn's gate-progress file
      agents/
        resolve.ts          finds agent binaries (§6)
        launch.ts           argument arrays per agent (from the spike)
        events.ts           stream parsers (from the spike)
        run.ts              process group, stream, cancel, timeout (from the spike)
    renderer/               screens from the prototype
  test/
```

### 3.4 The agent bridge

Proven in `spikes/agent-bridge/`; the findings are in `agent-bridge.md`.

**One turn is one process group.** For each turn the bridge spawns the agent CLI with an argument array (never a shell), writes the prompt to stdin, and parses stdout line by line.

| Agent | A turn | Restrictions (verified) | Next turn in the same session |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --mcp-config <json> --strict-mcp-config` | `--setting-sources ""` (no user hooks, plugins or key helpers); `--tools ""` (no built-in tools; `WebSearch,WebFetch` in research); `--allowedTools` set to that turn's Codemm tools | `--resume <session_id>` |
| Codex | `codex exec --json --skip-git-repo-check --ignore-user-config -c mcp_servers.codemm.*=… -` | `--disable` `shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use`, `multi_agent` and `image_generation`; `sandbox_mode="read-only"`; `web_search="disabled"` (`"live"` in research); `enabled_tools=[…]` with `default_tools_approval_mode="approve"` | `codex exec resume <thread_id> …` |
| Cursor | `cursor-agent -p --output-format stream-json --approve-mcps`, with `.cursor/mcp.json` | `--mode ask` (unverified) | `--resume <chatId>` (unverified) |

**Events.** The parsers work from an allowlist and never throw on malformed lines. They emit five event kinds:

- `session`: the session id;
- `text`: top-level assistant text, in tutor turns only;
- `tool`: a Codemm tool's name with `started`, `ok` or `failed`;
- `web`: the `https:` URLs returned by a web search or fetch that succeeded. These come from research turns only, which carry no hidden data;
- `done`: success or failure, with no error text.

Tool inputs and results, thinking, subagent messages, other tools and the agent's error text are all dropped. A failure is shown as a §8 state. Up to 4 KB of the agent's stderr goes to a local log, never to the screen, and raw stdout is never logged.

**Cancellation and cleanup.** Each turn is its own process group:

- cancelling sends SIGTERM, then SIGKILL after 5 s;
- when the agent exits, for any reason, whatever is left in its group is killed. That covers an MCP server or child that ignores SIGTERM, which a test proves with a fake agent;
- the group is inspected by group id. If inspection fails, that is reported as a cleanup failure, never as an empty group;
- after a cancelled or failed turn, the app runs `doctor`'s owner-aware container cleanup, so judge or build containers whose `codemm mcp` owner is gone are removed (§5.8);
- Windows uses `taskkill /T /F` (unverified);
- every turn has a wall-clock limit (§9).

**Sign-in** is read from the agents' own status commands (`claude auth status`, `codex login status`, `cursor-agent status`). Only one yes/no is kept: signed in with a subscription. That means Claude's `authMethod: "claude.ai"` and Codex's "Logged in using ChatGPT"; Cursor's form is unverified. Codemm never opens the agents' credential files or keychain entries. A Claude turn whose init event reports an API-key source is stopped and failed (spec-level; not in the spike).

**Connected** means a real handshake: one turn in which the agent calls `list_tracks` and the bridge sees the call succeed. It runs on Connect and after a failure, not on every launch. The Connect screen shows configured, signed in, connected and sandbox ready (`doctor`) as separate states.

**Turn kinds.** `flow.ts` picks the turn and `turns.ts` defines it. Tutor turns resume the course's tutor session and stream text. Author turns start a fresh session that isn't saved (`--no-session-persistence`, `--ephemeral`) and show only progress.

| Turn | Kind | Starts when | Codemm tools | Agent's own tools | Success check |
|---|---|---|---|---|---|
| connect | tutor | Connect screen | `list_tracks` | none | `list_tracks` ok |
| research | tutor | a goal is entered | `list_tracks`, `draft_roadmap` | web search and fetch | a valid draft exists, and at least one `web` event was seen |
| revise | tutor | "Ask Codemm for changes" | `draft_roadmap` | none | the draft changed |
| setup | author | the learner says yes to setup | `list_tracks`, `save_track` (bound by `--install`) | none | the approved track is installed |
| lesson | author | a concept needs a lesson (§3.5) | `save_lesson` | none | a new lesson for that concept |
| exercise | author | `next_step` is `author`, or §3.5 asks for one | `list_tracks`, `save_exercise` | none | a new exercise with the requested concept, difficulty and style exists, and (for `author` jobs) `next_step` now returns `practice` with it |
| chat | tutor | the learner sends a message | `progress`, `get_roadmap` | none | none |
| assist | tutor | the learner says yes to "Let Codemm edit" | `get_exercise` | editing, limited to the exercise folder where the agent supports it: Claude's `Edit` and `Write` with a path rule; Codex's `workspace-write` sandbox with its shell still disabled (both unverified) | the turn ends |

- **Context goes in the prompt.** Chat turns include the screen's content: the lesson text, or the statement, the learner's code and the last `CheckView`. The tutor can hint without extra tool calls.
- **Checks are the app's job.** The app runs every check (`app.checkExercise`), never the agent, so each attempt is recorded once.
- **Assist turns** start only after `app.setAssist(on)` records the evidence (core §7). `app.setAssist(off)` follows when the turn ends, however it ends.

### 3.5 Flow rules (desktop only, no core change)

- **Lessons during setup.** Once the learner approves the draft, the app writes the first concept's lesson while setup runs. Further lessons follow `next_step` after the course is saved.
- **Try an easier one** (shown when `next_step` is `stuck`): the app runs an exercise job for that concept at difficulty 1 and opens the result by id. A perfect check on it resets the fail streak, which clears `stuck` under the existing core rules (§7).
- **After an assisted pass,** the app runs an exercise job for the same concept and difficulty and opens that next, as the prototype promises. Then `next_step` takes over again.
- **Reuse.** Research runs once per goal unless the learner asks for changes. Drafts and lessons are saved, so nothing is regenerated when the app reopens.

## 4. Learner-safe boundary

- **Never sent to the renderer:**
  - solutions, mutants and hidden tests;
  - hidden test names, messages and expected outputs;
  - author-session text, tool inputs and results;
  - raw agent output and agent error text;
  - file paths under `$CODEMM_HOME`.
- **Enforced in three places:** the core already reduces hidden results to an index and a status; `views.ts` builds every renderer payload field by field; the bridge parsers drop everything outside their allowlist, including all text from author turns.
- **The tutor's own text is honor-system,** as in the core (§1 and §4.2 of the core spec). The tutor never sees author work and has no file tools, but an agent that disobeyed could still have read course files some other way.
- **Lesson Markdown** is rendered without raw HTML, scripts, iframes or remote images. Code blocks are static text.

## 5. Core additions (the smallest set)

All of them go through `schemas`, `store` and `app`, hold the course lock when mutating, write atomically, and carry `format_version: 1`. New MCP tools are thin, like the existing ones. `templates.ts` gains one step each for lessons and drafts.

### 5.1 Lessons

- **Every lesson operation names its course.** The MCP tools take `course?` (defaulting to the active course) and the app functions take `course` explicitly. So a lesson for an approved draft can be saved, read, finished, edited and annotated before the course exists.
- **`save_lesson`** `{ course?, concept, title, body, predict? }` → `{ lesson: <slug> }`.
  - The concept must exist in that course or in its approved draft, so lessons can be written while setup runs.
  - `body` is Markdown, up to 20 KB.
  - `predict` is optional: `{ question, choices (2 to 4), answer (index), explain }`, a static "predict first, then see it" question.
  - Codemm makes the slug (`<concept>-<n>`), so the agent never has to invent one.
- **`get_lesson`** `{ course?, lesson }` returns the lesson with the learner's edits and note applied. It records nothing.
- **`finish_lesson`** `{ course?, lesson }` (or `app.finishLesson` from the app, when the learner presses Next) records `{ kind: "read", at, lesson }`. A repeat call records nothing. Read events never change mastery.
- **Learner edits and notes** go through `app.editLesson(course, lesson, body)` and `app.noteLesson(course, lesson, text)`. They're stored beside the agent's original, which never changes, so an agent can't overwrite them.
- **Storage:** `courses/<course>/lessons/<slug>/lesson.json` holds the original, and `learner.json` holds the edits and note. `store.listCourses` ignores folders that have no `course.json`.
- **`next_step` gains a `lesson` kind,** checked after a concept is chosen and before `stuck`, `practice` or `author`:
  - no lesson for the concept → `{ kind: "lesson", concept }` (write one);
  - an unread lesson → `{ kind: "lesson", concept, lesson }` (the earliest unread one).
- Prediction answers aren't recorded. Lessons are not a second mastery system.

### 5.2 Roadmap read and edit

- **`get_roadmap`** returns `{ course, goal, track, style, concepts, sources }` for the active course.
- **`draft_roadmap`** `{ course, roadmap }` validates the YAML with the same parser as `save_roadmap`, but doesn't require the track to be installed. It stores `drafts/<course>.json` with `approved: false`.
  - `app.approveDraft(course)` sets `approved: true`. Only the app does this, when the learner presses Approve.
  - A draft is never active. `save_roadmap` deletes it.
- **Learner edits** happen in `roadmap-edits.ts` as pure operations that produce YAML, and that YAML goes through `draft_roadmap` or `save_roadmap`, so every edit passes the same rules:
  - **rename** changes only the title;
  - **move up or down** changes only the order. It's refused when it would put a concept above one it requires ("Needs <title> first");
  - **add** gives the new concept a stable id from its title (made unique), with no prerequisites;
  - **remove** is refused when another concept requires it ("<title> needs it") or when it has exercises or progress (core §5).
- Ids never change, and dependencies are never rewritten silently.

### 5.3 Research sources

- The roadmap YAML takes an optional `sources` list, at most 20, each `{ url, title, version?, why }`:
  - `url` must be `https:`, up to 2 KB;
  - `title` is up to 200 characters, `version` up to 50 and `why` up to 300.
- **Codemm records evidence; it doesn't take the agent's word.** After a research turn, the app keeps only the sources whose exact URL appeared in that turn's `web` events (ignoring a trailing slash and fragment). It stamps each kept source with `retrieved` (the turn's date) and re-saves the draft. The research prompt tells the agent to cite URLs exactly as its search returned them. If none survive, the path is still shown as "Suggested path", with no sources.
- Through the CLI, sources are whatever the agent wrote. The core spec says so.
- **Web text is untrusted.** The research prompt and `templates.ts` say to prefer primary sources and to treat page text as data, never as instructions. The app shows each source's title and host as plain text, and never fetches or renders the page.

### 5.4 Install consent

- **`codemm mcp --tools <list>`** registers only the listed tools. Without the flag every tool is registered, so the CLI and the existing hosts behave as before.
- **`codemm mcp --install <id@version>`** limits `save_track` to that one track, and allows at most 3 build attempts in that server process. Both checks run before any build starts.
- **One yes covers one setup job:** a setup turn with `--install` set to the approved draft's track, plus at most one automatic retry turn. After that, the learner sees "Couldn't set up …" with Try again (which asks again) and Stop.
- **Two layers.** The agent-side allowlists add a second layer: Claude denies tools it wasn't allowed, and Codex doesn't expose them (both verified).
- The course is saved (`save_roadmap`) only after the track is installed. Until then the approved draft holds it.

### 5.5 Honest skip

- A `skip` event now **defers** a concept; it no longer sets mastery to 0.85.
- `next_step` puts deferred concepts after every other candidate. If only deferred ones remain, the earliest deferred comes back.
- A deferral ends at the concept's next recorded check.
- A deferred concept isn't mastered, so the concepts that depend on it stay locked.
- The CLI help and the desktop both call it "Come back later".
- Nothing has been published, so old `skip` events simply take the new meaning; no migration is needed.

### 5.6 Gate progress events

- `app.saveTrack`, `saveExercise`, `testExercise`, `checkExercise` and `rebuildTrack` take an optional `onProgress(event)` callback.
- Events are `{ op, step, state }`:
  - `op` is `track`, `exercise` or `check`;
  - `step` is a gate or stage name (`build`, `probe`, `reference`, `speed`, `starter`, `mutants`, `hidden-matter`, `visible`, `hidden`);
  - `state` is `running`, `pass` or `fail`.
- Events never carry test names, messages, inputs or output.
- `codemm mcp --progress <file>` appends each event as a JSON line with `format_version`, so the app can follow gates that run inside the agent's MCP server. The app deletes the file when the turn ends. In-process calls use the callback directly.

### 5.7 Learner files

- **Reading:** `getExercise` also returns `code`, the current text of the exercise's learner files only (through `store.readLearnerFiles`). The editor loads this, and the tutor sees the learner's code in its prompt.
- **Saving:** `app.writeLearnerFile(ws, exercise, file, text)` accepts only those files, refuses symlinked paths, and replaces the file atomically. The renderer never touches the file system.

### 5.8 Stopping cleanly

`codemm mcp` and the CLI remove their own running containers when they get SIGTERM or SIGINT. If one is killed outright, its containers are left behind, but `doctor`'s existing owner-aware cleanup removes them because their owner PID is gone. The app runs that cleanup after any cancelled or failed turn.

### 5.9 Review scheduling

Deferred. It needs a time-based rule, new exercises and a failure policy, so it isn't tiny.

## 6. Cross-platform support

| | macOS | Windows | Linux |
|---|---|---|---|
| Container runtime | Docker Desktop | Docker Desktop with the WSL2 backend | Docker Engine (user in the `docker` group, or rootless) |
| Installer | `.dmg` (arm64, x64) | NSIS `.exe` (x64) | `.deb` and AppImage (x64) |
| Stopping a turn | process group | `taskkill /T /F` | process group |

- **Finding agents.** Apps opened from a desktop don't get the shell's `PATH` (the spike reproduced this). `resolve.ts` searches `PATH` and then a fixed list of standard install folders for each OS, such as `~/.local/bin`, `/opt/homebrew/bin`, the npm global prefix and `%APPDATA%\npm`. It never runs a login shell to find them.
- **Windows shims.** Agents installed with npm are `.cmd` shims, and Node refuses to spawn those without a shell. `resolve.ts` runs the shim's JavaScript entry with Electron as Node instead, or uses the native `.exe` when one exists. This is unverified here.
- **Paths.** Docker Desktop shares the user's temp and home folders by default, which is where Codemm's run folders live. `--user` is set only on POSIX, as now.
- **Linux AppImage.** On distributions that restrict unprivileged user namespaces (such as Ubuntu 24.04), Electron's sandbox can't start from an AppImage. The `.deb` is the recommended package. The app never runs with `--no-sandbox`.
- **Core portability fixes** (paths, signals and the sandbox on Windows) belong to the cross-platform core work. The desktop depends on them.

## 7. Packaging

- **Build.** electron-builder with `--publish never`. The core and its production dependencies are bundled unpacked under `resources/core`, outside the asar archive, so the agent's MCP server can run them with `ELECTRON_RUN_AS_NODE=1`.
- **Unsigned for 1.0.** The release notes give the steps:
  - on macOS, open the app once, then choose **System Settings → Privacy & Security → Open Anyway**;
  - on Windows, SmartScreen needs **More info → Run anyway**.
- **Later.** Signing, notarization and auto-update wait for the owner's Apple Developer and Windows signing accounts.
- **CI** builds the installers on each OS as artifacts. Publishing needs the owner's go-ahead.

## 8. Failure states

**A failure records nothing itself.** Anything committed before the failure stays: a saved exercise or lesson, an installed track, an `assist` event. The app always continues from Codemm's state. Learner-caused outcomes are graded and recorded as the core already does: build errors, timeouts, crashes and output floods count as `error`.

| What failed | What the failure records | What the learner sees |
|---|---|---|
| Docker isn't running | nothing | "This check wasn't counted. Docker isn't running. Start it, then try again." |
| Image missing or changed | nothing | Rebuild, on the Tracks screen |
| Agent not found | nothing | Connect: how to install it |
| Agent signed out | nothing | Connect: "Not signed in. Sign in to <agent> first." |
| Handshake fails while signed in (often a model the plan doesn't include) | nothing | Connect: choose another model (O5) |
| Rate limit, crash, network loss or timeout in a turn | nothing | "Codemm couldn't finish that. Try again." |
| The turn is cancelled | nothing | the panel stops |
| The MCP server doesn't start | nothing | Connect: the sandbox-ready state fails, and `doctor` names why |
| Setup still fails after its retries | nothing (the approved draft and any lessons stay; if a track did install before the failure, the app saves the course and carries on) | "Couldn't set up …" with Try again and Stop |
| An exercise still fails its gates after retries | nothing | "Codemm couldn't prepare an activity. Try again." |
| An assist turn fails | nothing more (the exercise stays assisted; assist mode is turned off) | "Codemm couldn't finish that. This one still counts as assisted." |
| The course is locked | nothing | "Busy. Try again." |

Author output that fails a gate is never stored, so a bad agent reply can't reach the learner.

## 9. Cross-model robustness

The flow has to work with each agent's smallest model, not only its best one.

- **Code makes the decisions.** `flow.ts` picks every next step from Codemm's state. The model never orchestrates the journey.
- **Prompts are short and single-purpose:** at most 12 lines per turn kind, naming the exact tools, with the context included.
- **Few tools per turn** (at most 3 from Codemm), enforced by `--tools` and by the agent's allowlist. Fewer tools also mean less context: Codex's input dropped from about 75k to 46k tokens when its extras were disabled.
- **State, not text.** A turn succeeds only when its check against Codemm passes. The spike recorded a weak model answering confidently after its tool call was blocked.
- **Gates catch bad content,** as in the core. Structured inputs (the `save_lesson` fields, Codemm-made slugs, the `--install` binding) remove whole classes of mistakes.
- **Retries are bounded:** at most 3 saves inside a turn, and at most one automatic repair turn per job, which states exactly what is missing. After that, the learner decides.
- **Turn time limits:** chat 3 min, research 5 min, lesson 5 min, exercise 10 min, setup 15 min.
- **Concurrency:** at most one tutor turn, one setup job and one content job at a time.

## 10. Acceptance criteria

Each item is verified by an automated test unless marked *journey*. Journeys use real agents and their evidence goes in the release notes.

| # | Requirement |
|---|---|
| D1 | CI builds unsigned installers on each OS (`.dmg` arm64 and x64, NSIS x64, `.deb` and AppImage x64), and a smoke test starts each built app to its first screen. |
| D2 | *Journey:* on each claimed platform, an installer downloaded through a browser from CI (so it carries the quarantine or download mark) installs and opens by following the §7 steps. |
| D3 | The app ships no languages: environment names, choices and colors come only from `list_tracks` and learner input. A renderer test proves the Tracks screen shows exactly what `list_tracks` returns, and the core A1 package check still passes. |
| D4 | No model calls and no credentials. The desktop has no model-API dependency. The agent's environment lacks the known key variables, and Claude turns load no setting sources. Sign-in state comes only from the agents' status commands, and an API-key sign-in counts as signed out. A Claude init event with an API-key source fails the turn. `agents/` imports no file-system API. |
| D5 | Bridge parsers turn the recorded Claude Code and Codex streams in `spikes/agent-bridge/fixtures` (and new recordings) into the expected events, including blocked tools, failed turns, web evidence and malformed lines. |
| D6 | Canary test: in a scripted journey, a fake agent puts a canary string in solutions, mutants, hidden tests, subagent text, author-turn text, tool inputs and results, web results outside research turns, and its error output. No IPC payload or agent event contains the canary. |
| D7 | Window security: context isolation, sandbox, no Node integration, a strict CSP, and blocked navigation and `window.open`, checked from the created window's settings. |
| D8 | Tool restriction. For every turn kind, an argument test pins the agent flags in §3.4. *Journey,* per verified agent: in a tutor turn the agent can't write a file, can't run a shell command and can't reach another MCP server, but can call its Codemm tools. |
| D9 | Lessons: `save_lesson`, `get_lesson` and `finish_lesson` schemas and gates. `get_lesson` records nothing. `finish_lesson` records one `read` event and repeats record nothing. Agent re-saves never overwrite learner edits or notes. `next_step` returns `lesson` before `practice` or `author`, and orders unread lessons. Lessons for an approved draft's concepts are accepted. |
| D10 | Roadmap edits keep ids. Moves above a prerequisite, and removals of required or used concepts, are refused. Every edit goes through the `save_roadmap` parser. `get_roadmap` returns the saved roadmap. Drafts don't need an installed track, are never active, and only the app approves them. |
| D11 | Sources: only `https:` URLs within the limits are accepted. After a research turn, only sources whose exact URL appeared in its `web` events (from successful calls) are kept, stamped with the turn's date. A research turn without `web` events fails its check. The renderer shows sources as text and opens them only through the system browser. |
| D12 | Install consent. Without `--tools`, every tool is registered; with it, only the listed ones. `--install` rejects any other track and a fourth build attempt before building. A test over every turn kind proves `save_track` appears only in setup turns, and that approving a roadmap alone never installs. |
| D13 | Skip defers without mastery. Dependents stay locked. Deferred concepts come last and return when nothing else is left. A recorded check of the concept clears the deferral. |
| D14 | Gate progress events arrive in order for a track install, an exercise save and a check, and never contain test names, messages, inputs or output (Docker test). |
| D15 | Failures. With Docker stopped, a missing image, or the agent missing, signed out, crashing, timing out or cancelled, the failure itself records nothing. Each case runs both before and after a commit point (an exercise saved, a track installed, an assist event), and afterwards the app continues from the committed state. `events.jsonl` changes only by what was committed. |
| D16 | Cleanup. When a turn ends or is cancelled, nothing is left in its process group, even a child that ignores SIGTERM (fake-agent test). A group that can't be inspected is a failure, not an empty group. Cancelling during a gate leaves no `codemm=1` container once cleanup runs (Docker test; not yet verified). |
| D17 | Flow rules (§3.5): an exercise job succeeds only when its result has the requested concept, difficulty and style, and, for `author` jobs, `next_step` selects it. Try an easier one yields a difficulty-1 exercise whose perfect check clears `stuck`. An assisted pass is followed by an exercise for the same concept and difficulty. Unit tests on `flow.ts` with core fakes. |
| D18 | Practice protection: only assist turns get editing; `setAssist(on)` happens before an assist turn starts, and `setAssist(off)` follows it on every exit path. |
| D19 | Agent names appear only on the Connect screen; the tutor is "Codemm" everywhere else (a test over renderer strings). |
| D20 | Learner files: `getExercise` returns only the exercise's learner files. Saves accept only those files, refuse symlinks and replace files atomically. |
| D21 | *Journey:* on macOS with Docker Desktop and on Linux with Docker Engine, using installers built by CI and each verified agent: connect, goal, research, edit, consent and setup, lesson, activity, failed then passed check, progress, Come back later, and the Docker-stopped state. |
| D22 | *Journey:* the D21 journey on Windows 11 with Docker Desktop (WSL2). If it can't be run, Windows stays experimental and the release notes say so. |
| D23 | *Journey:* the flow completes with each verified agent's smallest model on the owner's plan, through the cross-model bench (`bench/`). Failures there must end in a §8 state, never in wrong recorded progress. |
| D24 | Cursor is verified like Claude Code and Codex once it is signed in, including D8. Until then it is marked experimental on the Connect screen. |
| D25 | The core's A1 to A16 still pass. The only behavior changes are the ones in §5, and `docs/DESIGN.md` documents them. |

## 11. Test strategy

Test-first throughout: write the failing test, make it pass simply, then refactor.

- **Core (vitest, `test/`):**
  - schemas and gates for lessons, drafts and sources;
  - the learner rules for `lesson`, `read` and deferral;
  - `--tools` and `--install`;
  - progress events and signal cleanup (Docker);
  - learner file reads and saves.
- **Desktop pure modules (vitest):**
  - `flow.ts` (state to turn, including the §3.5 rules);
  - `turns.ts` (tool lists, flags, prompt length, success checks);
  - `roadmap-edits.ts`;
  - `events.ts` (recorded fixtures);
  - `launch.ts` (argument arrays per OS);
  - `run.ts` (the fake stubborn agent);
  - `resolve.ts` (folder lists per OS).
- **IPC:** handlers run against a fake `app`, asserting validation and that only view types come back. The D6 canary test lives here.
- **Renderer:** Testing Library tests per screen state, including the empty, failure and disconnected ones.
- **End to end:** Playwright drives Electron with a **fake agent**, a small script that speaks the Claude stream-json format and makes real calls to the bundled `codemm mcp`. The whole journey runs in CI without a model. Docker tests run where Docker is available, as in the core.
- **Journeys:** D2, D8, and D21 to D24 run with real agents and installers before release.

## 12. Deferred

- **Product:**
  - spaced review, and the Review card;
  - showing a track's Dockerfile before setup;
  - executable lesson examples;
  - placement quizzes, streaks and activity history;
  - multiple workspaces in the app;
  - localization.
- **Agent integration:**
  - persistent agent sessions (Claude's `--input-format stream-json`) and token-by-token streaming; one process per turn is enough for 1.0;
  - a recommended-model list (it comes from the bench).
- **Platforms:**
  - Windows and Linux on arm64;
  - Podman in the desktop (the core already supports it experimentally).
- **Distribution:** signing, notarization, auto-update and store distribution.

## 13. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| O1 | Setup consent wording | Add one plain line to the dialog: "Setup runs your agent's install steps with internet access." The prototype's "Downloads once. Graded runs are offline." alone understates it. |
| O2 | How many tries one "yes" covers | One setup job: a turn plus one automatic retry, with at most 3 builds each. Try again asks again. |
| O3 | Subscription only | As specified: accept only subscription sign-ins and strip key variables, so "uses your plan" is true and there are no surprise API bills. The cost: learners who use their agent only through an API key can't connect in 1.0. |
| O4 | The learner's own agent settings | As specified: turns load no user settings, hooks or plugins (Claude `--setting-sources ""`, Codex `--ignore-user-config`). This closes the host-execution path through hooks and makes turns faster (the spike's Claude first event dropped from 3 to 14 s to 1.3 to 3.4 s). The cost: the learner's custom agent setup doesn't apply inside Codemm. |
| O5 | The model when a handshake fails while signed in | Show "choose another model" on Connect. Use the agent's own list where one exists (`cursor-agent --list-models`), and free text otherwise. |
| O6 | Workspace location | `~/Codemm`, which the learner can change at first run. |
| O7 | Windows support claim | Experimental unless someone runs D22 on a Windows machine before release. |
| O8 | Signing accounts | Needed before signed builds: an Apple Developer ID for notarization and a Windows code-signing certificate. |

## 14. Next steps

1. Core: the §5 additions in `src/`, test-first, and the matching update to `docs/DESIGN.md`. That update covers lessons, `read` and the skip change, the new tools, `--tools`, `--install`, `--progress` and signal cleanup, and removing "any UI" from core §2 "Deferred".
2. Desktop shell: adopt §3.3, and port `launch.ts`, `events.ts` and `run.ts` from the spike into `desktop/src/main/agents/`.

## 15. Review log

**Astra (gpt-6-astra), review of this spec and the spike, 17 Oct 2026.** Verdict: "not ready for implementation; resolve the boundary, consent, and learner-state contracts first". All findings were accepted:

| # | Finding | Resolution |
|---|---|---|
| 1 | Blocker: allowlists don't remove the agent's own tools; Codex can still run host commands; other MCP servers stay reachable | §1.5 and §3.4: Claude gets `--tools ""` and `--strict-mcp-config`; Codex gets `--ignore-user-config` and its shell and extras disabled. Verified live, with a control run where Codex did run `/bin/zsh -lc pwd`. D8. |
| 2 | Setup permission broader than the approved job | §5.4 `--install <id@version>`, with at most 3 builds per server, both checked before building. D12. |
| 3 | Lessons during setup had no course context | §5.1 `course` parameter and approved drafts; §5.2 `approveDraft`; §3.5. |
| 4 | The editor couldn't load learner code | §5.7 `getExercise` returns `code`. D20. |
| 5 | An exercise at the wrong difficulty passed the success check | §3.4: success means `next_step` selects it. D17. |
| 6 | "Try an easier one" undefined | §3.5, using the existing streak reset. D17. |
| 7 | The assisted follow-up wasn't guaranteed | §3.5 explicit follow-up job. D17. |
| 8 | Failure rows contradicted committed state | §8: failures record nothing themselves, committed state stays, and the app continues from it. D15 covers both before and after commit. |
| 9 | Cancellation evidence didn't prove cleanup | Spike `run.ts`: process-group kill on every exit, with group-based counting; fake stubborn-agent test with a mutation check. §5.8 container cleanup. D16. |
| 10 | Author text and raw errors passed through | Spike parser: `text: false` for author turns, and `done` carries no error text; canary tests. D6. |
| 11 | Fetching a lesson recorded reading | §5.1: `get_lesson` is pure; `finish_lesson` records once. D9. |
| 12 | Research could succeed without research | §5.3: sources kept only with observed `web` evidence, and the date stamped by Codemm. A research turn needs `web` events. Verified for both agents. D11. |
| 13 | Credential policy contradicted "never forwards credentials" | §1.4: remove the key variables (O3 states the trade-off). D4. |
| 14 | Malformed stream objects crashed the parser | Spike parser validates shapes and ignores bad lines (tests). |
| 15 | Wrong macOS unsigned-app steps; CI artifacts aren't downloaded installers | §7 Open Anyway steps; D2 downloaded-installer journey. |

Astra also judged its earlier prototype findings 1 to 8 partly resolved. The rows above, plus the §2 wording changes (monochrome until connected, reuse of research and lessons), complete them.

**Astra re-check, 17 Oct 2026.** 8 resolved (2, 4, 6, 7, 11, 14, 15) and 7 partly resolved, plus one new major issue. Resolutions:

| Item | Resolution |
|---|---|
| 1 Claude hooks still execute | §3.4 `--setting-sources ""` (verified live: no hook events, sign-in unaffected); O4 decided |
| 3 Draft lessons had no course identity for read, finish and edit | §5.1: every lesson operation names its course |
| 5 Style not validated | §3.4 and D17: success also requires the requested style |
| 8 Setup-failure row asserted "no track" | §8 row now depends on reconciliation |
| 9 Failed process inspection read as zero survivors | Spike `members` throws unless pgrep says "none" (test); §3.4 and D16. Container cleanup on cancel stays unverified (D16 Docker test). |
| 10 and new: web URLs leaked in author mode, uncorrelated | Spike parser: `web` events only when research is on, and only from successful WebSearch and WebFetch calls matched by id (tests, including a forged result and a failed fetch); D6 |
| 12 Host matching allowed invented paths | §5.3 exact URL match; D11 |
| 13 Stored API auth and key helpers | §1.4 subscription-only sign-in (spike `signedIn`, tests), no user settings, and the init-event check (spec-level); O3 |

Astra's sandbox couldn't run `pgrep`, so its run of the cancellation test failed there. The test passes here, and `members` now reports that situation as an error.
