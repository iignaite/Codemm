# Codemm desktop 1.0 design

Status: draft for review. It extends `docs/DESIGN.md` (the core spec), which still governs everything it doesn't change. The screens follow the approved journey prototype (`codemm-journeys.html`), with Astra's design review applied (§13). The agent bridge was proven with real agents; the evidence is in `docs/desktop/agent-bridge.md`.

## 1. Decisions

1. **1.0 is the core harness plus an Electron desktop app** for macOS, Windows and Linux. The CLI and MCP server stay as they are, apart from the additions in §5.
2. **The desktop drives the journey, and the agent does one small job per turn.** The app decides what happens next from Codemm's state. Each agent turn has a short prompt, a few tools, and a success check against Codemm's state, never against the agent's text. This is what makes weak models usable (§9).
3. **The app launches the learner's own agent CLI headless**: Claude Code, Codex, or Cursor. It gives the agent Codemm's MCP server and streams the replies into the Codemm panel.
4. **The invariant "Codemm never calls a model" now means:** Codemm launches the learner's agent; it never calls a model API, and never reads, stores or forwards credentials. The core package (`src/`) still never starts an agent. Only `desktop/` does.
5. **Author work runs in separate, unseen agent sessions.** Installing a track and writing an exercise each run in a fresh session whose text the app discards; only tool statuses and gate progress reach the screen. The tutor session never sees the author's work. This replaces subagents in the desktop and works the same for every agent.
6. **The renderer is learner-safe by construction.** It receives only view types built in one main-process module. Solutions, mutants, hidden tests, expected hidden outputs and author transcripts never cross the preload bridge.
7. **Installing is its own decision.** Approving a roadmap never installs anything. `save_track` exists only in a setup turn that starts after the learner says yes.
8. **Installers are unsigned for 1.0.** Signing and notarization wait for the owner's accounts.

## 2. Scope

**In 1.0:** the core (unchanged guarantees), the desktop app, the core additions in §5, and the screens in the prototype, with these changes from the review:

- the tutor is always called **Codemm**; agent names appear only on the Connect screen;
- "Languages" becomes **Tracks**, filled from `list_tracks`; colors come from a hash of the track id, never from a name table;
- the research result is labeled **Suggested path**, with real sources (§5.3);
- "Skip for now" becomes **Come back later**, which defers the topic and doesn't master it (§5.5);
- setup is a separate consent dialog, which says that installing runs your agent's install steps with internet access, and that graded runs have none;
- lessons show static examples; nothing an agent writes runs in the app;
- practice protection is enforced through the agent's own tool permissions in every turn (§3.4), and Practice mode says so.

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

- **It calls the core `app` functions directly**, in-process: `listTracks`, `saveRoadmap`, `getExercise`, `testExercise`, `checkExercise`, `progress`, `skip`, `setAssist`, `rebuildTrack`, and the §5 additions. Long operations are already asynchronous (they wait on Docker), so the main thread stays responsive.
- **The agent's MCP server** is the bundled core CLI run by Electron itself: `command` is `process.execPath`, `args` is `[<resources>/core/cli.js, "mcp", "--workspace", <ws>, "--tools", <list>, "--progress", <file>]`, and `env` has `ELECTRON_RUN_AS_NODE=1` and `CODEMM_HOME`. Learners don't need Node installed.
- **Locks are shared.** The app and the agent's MCP server are separate processes that use the same PID-based course and track locks (core §10).
- **Settings** (chosen agent, model, workspace folder, tutor session id per course) live in `settings.json` in Electron's userData folder, with `format_version`, written atomically.
- **The workspace** defaults to `~/Codemm`. The learner can change it at first run.

### 3.2 Preload bridge and IPC

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a strict CSP with no remote origins, navigation and `window.open` blocked. Links open in the system browser through `shell.openExternal`, and only for `https:` URLs.
- The preload script exposes one frozen object, `window.codemm`, typed in `src/shared/api.ts`. It never exposes `ipcRenderer`.
- **IPC handlers are thin:** validate the arguments with zod, call one core or bridge function, and return a view. They hold no logic.
- **`views.ts` is the only module that shapes data for the renderer.** Each view type lists its fields explicitly (`CheckView` from core is already learner-safe; `ExerciseView` comes from `getExercise`; `LessonView`, `RoadmapView`, `AgentEvent` and `GateEvent` are new). Nothing is spread from a core record.

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
      flow.ts               pure: the next turn or screen, from Codemm state
      turns.ts              pure: each turn kind's prompt, tools and success check
      roadmap-edits.ts      pure: rename, move, add, remove → roadmap YAML
      settings.ts           settings.json
      progress.ts           reads a turn's gate-progress file
      agents/
        resolve.ts          finds agent binaries (§6)
        launch.ts           argument arrays per agent (from the spike)
        events.ts           stream parsers (from the spike)
        run.ts              spawn, stream, cancel, timeout
    renderer/               screens from the prototype
  test/
```

### 3.4 The agent bridge

Proven in `spikes/agent-bridge/` (findings in `agent-bridge.md`).

**One turn is one process.** For each turn the bridge spawns the agent CLI with an argument array (never a shell), writes the prompt to stdin, and parses stdout line by line:

| Agent | Turn | Next turn in the same session |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --mcp-config <json> --strict-mcp-config --allowedTools <list>` | `--resume <session_id>` |
| Codex | `codex exec --json --skip-git-repo-check -c sandbox_mode="read-only" -c mcp_servers.codemm.*=… -c …enabled_tools=[…] -c …default_tools_approval_mode="approve" -` | `codex exec resume <thread_id> …` |
| Cursor | `cursor-agent -p --output-format stream-json --approve-mcps` with `.cursor/mcp.json` | `--resume <chatId>` (unverified) |

- **Events.** The parsers turn each stream into four event kinds: `session` (id), `text` (top-level assistant text), `tool` (a Codemm tool name with `started`, `ok` or `failed`), and `done` (`ok`, with the agent's error if any). The parsers work from an allowlist: tool inputs and results, thinking, subagent messages and other tools' calls are dropped. The app never logs raw agent output.
- **Cancellation** kills the agent's process tree: a process group on POSIX (SIGTERM, then SIGKILL after 5 s), and `taskkill /T /F` on Windows. Every turn has a wall-clock limit (§9).
- **Sign-in** is read from the agents' own status commands (`claude auth status`, `codex login status`, `cursor-agent status`), and only the signed-in yes/no is kept. Codemm never opens their credential files or keychain entries.
- **Environment.** The agent gets the environment the app was launched with. Codemm neither adds nor removes credentials (open decision O3).
- **Connected** means a real handshake: a turn in which the agent calls `list_tracks` and the bridge sees the call succeed. Configured, signed in, connected and sandbox ready (`doctor`) are separate states on the Connect screen.

**Turn kinds.** `flow.ts` picks the turn and `turns.ts` defines it. Tutor turns stream text into the Codemm panel; author turns show only progress.

| Turn | Starts when | Codemm tools | Agent's own tools | Shown | Success check |
|---|---|---|---|---|---|
| connect | Connect screen | `list_tracks` | none | status | `list_tracks` ok |
| research | a goal is entered | `list_tracks`, `draft_roadmap` | web search and fetch | text | a valid draft exists |
| revise | "Ask Codemm for changes" | `draft_roadmap` | none | text | the draft changed |
| setup | the learner says yes to setup | `list_tracks`, `save_track` | none | progress | the draft's track is installed |
| lesson | `next_step` is `lesson` without an id | `get_roadmap`, `save_lesson` | none | progress | a new lesson for that concept |
| exercise | `next_step` is `author` | `get_roadmap`, `save_exercise` | none | progress | a new exercise for that concept |
| chat | the learner sends a message | `progress`, `get_roadmap` | none | text | none |
| assist | the learner says yes to "Let Codemm edit" | `get_exercise` | edit, limited to that exercise's folder | text | the turn ends |

- Tutor turns (connect, research, revise, chat, assist) resume the course's tutor session. Author turns (setup, lesson, exercise) start a fresh session that isn't persisted (`--no-session-persistence`, `--ephemeral`), and their text is discarded.
- **Practice protection.** No turn except assist gets the agent's edit, write or shell tools: Claude gets only the listed tools, Codex runs in its read-only sandbox, and Cursor runs in ask mode (unverified). An assist turn starts only after `app.setAssist(on)` records the evidence (core §7), and `setAssist(off)` follows when the turn ends. The next activity is one to solve alone, as the prototype says.
- **The prompt carries the context.** Chat turns include the screen's content (the lesson text, or the statement and the last `CheckView`), so the tutor can hint without extra tool calls. A check is always run by the app (`app.checkExercise`), never by the agent, so attempts are recorded once.

## 4. Learner-safe boundary

- **Never sent to the renderer:** solutions, mutants, hidden tests, hidden test names and messages, expected hidden outputs, author-session text, tool inputs and results, raw agent output, and file paths under `$CODEMM_HOME`.
- **Enforced in three places:** core functions already reduce hidden results to an index and a status; `views.ts` builds every renderer payload field by field; the bridge parsers drop everything outside their allowlist.
- **The tutor's own text is honor-system,** as in the core (§1 and §4.2 of the core spec): the tutor session never sees author work, and its instructions say not to read course files, but an agent that disobeys could still read them from disk.
- **Lesson Markdown** is rendered without raw HTML, scripts, iframes or remote images. Code blocks are static text.

## 5. Core additions (the smallest set)

All of them go through `schemas`, `store` and `app`, hold the course lock when mutating, write atomically, and carry `format_version: 1`. New MCP tools are thin, like the existing ones.

### 5.1 Lessons

- **`save_lesson`** `{ concept, title, body, predict? }` → `{ lesson: <slug> }`. `body` is Markdown, up to 20 KB. `predict` is optional: `{ question, choices (2 to 4), answer (index), explain }`, a static "predict first, then see it" question. Codemm makes the slug (`<concept>-<n>`), so the agent never has to invent one. Gates: valid schema, a concept in the course (or in its approved draft, so lessons can be written while setup runs), and within the limits.
- **`get_lesson`** `{ lesson }` → the lesson with the learner's edits and note applied. It records a `read` event: `{ kind: "read", at, lesson }`. Read events never change mastery.
- **Learner edits and notes** go through `app.editLesson(ws, lesson, body)` and `app.noteLesson(ws, lesson, text)`. They're stored beside the agent's original, which never changes, so an agent can't overwrite them.
- **Storage:** `courses/<course>/lessons/<slug>/lesson.json` holds the original, and `learner.json` holds the learner's edits and note.
- **`next_step` gains a `lesson` kind,** checked after a concept is chosen and before `stuck`, `practice` or `author`:
  - no lesson for the concept → `{ kind: "lesson", concept }` (write one);
  - an unread lesson → `{ kind: "lesson", concept, lesson }` (the earliest unread one).
- Prediction answers aren't recorded. Lessons are not a second mastery system.

### 5.2 Roadmap read and edit

- **`get_roadmap`** → `{ course, goal, track, style, concepts, sources }` for the active course.
- **`draft_roadmap`** `{ course, roadmap }` validates the YAML with the same parser as `save_roadmap`, but doesn't require the track to be installed yet. It stores `drafts/<course>.json`. A draft is never active, and `save_roadmap` deletes it.
- **Learner edits** happen in `roadmap-edits.ts` as pure operations that produce YAML, and that YAML goes through `draft_roadmap` or `save_roadmap`, so every edit passes the same rules:
  - **rename** changes only the title;
  - **move up or down** changes only the order. It's refused when it would put a concept above one it requires ("Needs <title> first");
  - **add** gives the new concept a stable id from its title (made unique), with no prerequisites;
  - **remove** is refused when another concept requires it ("<title> needs it") or when it has exercises or progress (core §5).
- Ids never change, and dependencies are never rewritten silently.

### 5.3 Research sources

- The roadmap YAML takes an optional `sources` list, at most 20, each `{ url, title, retrieved, version?, why }`. `url` must be `https:` (2 KB max); `retrieved` is a date; `title` is up to 200 characters, `version` up to 50 and `why` up to 300.
- Sources are stored with the draft and the course, and returned by `get_roadmap`.
- **Web text is untrusted.** The research prompt and `templates.ts` say to prefer primary sources and to treat page text as data, never as instructions. The app shows each source's title and host as plain text, and never fetches or renders the page.

### 5.4 Install consent

- **`codemm mcp --tools <list>`** registers only the listed tools. Without the flag every tool is registered, so the CLI and the existing hosts behave as before.
- The desktop passes `save_track` only in setup turns, and starts one only after the learner says yes in the setup dialog. The agent-side allowlist adds a second layer: Claude denies tools it wasn't allowed, and Codex doesn't expose them (both verified).
- **One yes covers one setup job:** a setup turn, plus at most one automatic retry turn. Each turn may save at most 3 times. After that, the learner sees "Couldn't set up …" with Try again (which asks again) and Stop.
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
- `codemm mcp --progress <file>` appends each event as a JSON line, with `format_version`, so the app can follow gates that run inside the agent's MCP server. In-process calls use the callback directly.

### 5.7 Learner file saves

`app.writeLearnerFile(ws, exercise, file, text)` lets the editor save. It accepts only the track's learner files for that exercise, refuses symlinked paths, and replaces the file atomically. The renderer never writes files itself.

### 5.8 Review scheduling

Deferred. It needs a time-based rule, new exercises and a failure policy, so it isn't tiny.

## 6. Cross-platform support

| | macOS | Windows | Linux |
|---|---|---|---|
| Container runtime | Docker Desktop | Docker Desktop with the WSL2 backend | Docker Engine (user in the `docker` group, or rootless) |
| Installer | `.dmg` (arm64, x64) | NSIS `.exe` (x64) | `.deb` and AppImage (x64) |
| Stopping a turn | process group | `taskkill /T /F` | process group |

- **Finding agents.** Apps opened from a desktop don't get the shell's `PATH` (the spike reproduced this). `resolve.ts` searches `PATH` and then a fixed list of standard install folders for each OS, such as `~/.local/bin`, `/opt/homebrew/bin`, the npm global prefix and `%APPDATA%\npm`. It never runs a login shell to find them.
- **Windows shims.** Agents installed with npm are `.cmd` shims, and Node refuses to spawn those without a shell. `resolve.ts` runs the shim's JavaScript entry with Electron as Node instead, or uses the native `.exe` when one exists. This is unverified here.
- **Paths:** Docker Desktop shares the user's temp and home folders by default, which is where Codemm's run folders live. `--user` is set only on POSIX, as now.
- **Linux AppImage:** on distributions that restrict unprivileged user namespaces (such as Ubuntu 24.04), Electron's sandbox can't start from an AppImage. The `.deb` is the recommended package. The app never runs with `--no-sandbox`.
- **Core portability fixes** (paths, signals and the sandbox on Windows) belong to the cross-platform core work. The desktop depends on them.

## 7. Packaging

- electron-builder with `--publish never`. The core is bundled unpacked under `resources/core` (outside the asar archive), so the agent's MCP server can run it with `ELECTRON_RUN_AS_NODE=1`.
- **Unsigned for 1.0.** macOS users open the app with right-click, then Open. Windows SmartScreen asks once. The release notes say so.
- Signing, notarization and auto-update are deferred until the owner provides the Apple Developer and Windows signing accounts. CI builds the installers on each OS as artifacts; publishing needs the owner's go-ahead.

## 8. Failure states

**Infrastructure failures record nothing.** Learner-caused outcomes are graded and recorded as the core already does: build errors, timeouts, crashes and output floods count as `error`.

| What failed | What's recorded | What the learner sees |
|---|---|---|
| Docker isn't running | nothing | "This check wasn't counted. Docker isn't running. Start it, then try again." |
| Image missing or changed | nothing | Rebuild, on the Tracks screen |
| Agent not found | nothing | Connect: how to install it |
| Agent signed out | nothing | Connect: "Not signed in. Sign in to <agent> first." |
| The plan rejects the model | nothing | Connect: choose another model |
| Rate limit, crash, network loss or timeout in a turn | nothing | "Codemm couldn't finish that. Try again." |
| The turn is cancelled | nothing | the panel stops |
| The MCP server doesn't start | nothing | Connect: the sandbox-ready state fails, and `doctor` names why |
| Setup still fails after its retries | nothing (no track, no course) | "Couldn't set up …" with Try again and Stop |
| An exercise still fails its gates after retries | nothing | "Codemm couldn't prepare an activity. Try again." |
| The course is locked | nothing | "Busy. Try again." |

- **Author output** that fails a gate is never stored, so a bad agent reply can't reach the learner.
- **Agent error text** goes to a local log, never to the screen. Even there it is capped and holds no raw stream.

## 9. Cross-model robustness

The flow has to work with each agent's smallest model, not only its best one.

- **Code makes the decisions.** `flow.ts` picks every next step from Codemm's state. The model never orchestrates the journey.
- **Prompts are short and single-purpose:** at most 12 lines per turn kind, naming the exact tools, with the context included.
- **Few tools per turn** (at most 3 from Codemm), enforced by `--tools` and the agent's allowlist.
- **State, not text.** A turn succeeds only when its check against Codemm passes. The spike recorded a weak model answering confidently after its tool call was blocked.
- **Gates catch bad content,** as in the core. Structured inputs (`save_lesson` fields, Codemm-made slugs) remove whole classes of mistakes.
- **Retries are bounded:** at most 3 saves inside a turn, and at most one automatic repair turn per job, which states exactly what is missing. After that, the learner decides.
- **Turn time limits:** chat 3 min, research 5 min, lesson 5 min, exercise 10 min, setup 15 min.
- **Concurrency:** at most one tutor turn, one setup job and one content job at a time.

## 10. Acceptance criteria

Each item is verified by an automated test unless marked *journey*. Journeys use real agents and their evidence goes in the release notes.

| # | Requirement |
|---|---|
| D1 | CI builds unsigned installers on each OS (`.dmg` arm64 and x64, NSIS x64, `.deb` and AppImage x64), and a smoke test starts each built app to its first screen. |
| D2 | The app ships no languages: environment names, choices and colors come only from `list_tracks` and learner input. A renderer test proves the Tracks screen shows exactly what `list_tracks` returns, and the core A1 package check still passes. |
| D3 | No model calls and no credentials: the desktop has no model-API dependency, sign-in state comes only from the agents' status commands (argument-array test), and the bridge never opens agent credential files. |
| D4 | Bridge parsers turn the recorded Claude Code and Codex streams in `spikes/agent-bridge/fixtures` (and new recordings) into the expected events, including blocked tools and failed turns. |
| D5 | Canary test: in a scripted journey with a fake agent whose solutions, mutants, hidden tests, subagent text and tool inputs contain a canary string, no IPC payload or agent event contains the canary. |
| D6 | Window security: context isolation, sandbox, no Node integration, a strict CSP, and blocked navigation and `window.open`, checked from the created window's settings. |
| D7 | Lessons: `save_lesson` and `get_lesson` schemas and gates; agent re-saves never overwrite learner edits or notes; `read` events; `next_step` returns `lesson` before `practice` or `author` and orders unread lessons. |
| D8 | Roadmap edits keep ids. Moves above a prerequisite and removals of required or used concepts are refused. Every edit goes through the `save_roadmap` parser. `get_roadmap` returns the saved roadmap. Drafts don't need an installed track and are never active. |
| D9 | Sources: only `https:` URLs within the limits are accepted; they're stored with the draft and the course; the renderer shows them as text and opens them only through the system browser. |
| D10 | Install consent: without `--tools`, every tool is registered. With it, only the listed ones. A test over every turn kind proves `save_track` appears only in setup turns, and that approving a roadmap alone never installs. |
| D11 | Skip defers without mastery. Dependents stay locked. Deferred concepts come last and return when nothing else is left. A recorded check of the concept clears the deferral. |
| D12 | Gate progress events arrive in order for a track install, an exercise save and a check, and never contain test names, messages, inputs or output (Docker test). |
| D13 | Infrastructure failures record nothing: with Docker stopped, a missing image, or the agent missing, signed out, crashing, timing out or cancelled, `events.jsonl` is unchanged and the §8 state is shown. |
| D14 | Practice protection: a test over every turn kind proves that only assist turns get edit tools, that `setAssist(on)` happens before an assist turn starts, and that `setAssist(off)` follows it. |
| D15 | Cancelling a turn leaves no agent or `codemm mcp` process behind (POSIX process group; `taskkill` on Windows). |
| D16 | Agent names appear only on the Connect screen; the tutor is "Codemm" everywhere else (a test over renderer strings). |
| D17 | Learner file saves accept only the exercise's track files, refuse symlinks and replace files atomically. |
| D18 | *Journey:* on macOS with Docker Desktop and on Linux with Docker Engine, using installers built by CI and each verified agent: connect, goal, research, edit, consent and setup, lesson, activity, failed then passed check, progress, Come back later, and the Docker-stopped state. |
| D19 | *Journey:* the D18 journey on Windows 11 with Docker Desktop (WSL2). If it can't be run, Windows stays experimental and the release notes say so. |
| D20 | *Journey:* the flow completes with each verified agent's smallest model on the owner's plan, through the cross-model bench (`bench/`). Failures there must end in a §8 state, never in wrong recorded progress. |
| D21 | Cursor is verified like Claude Code and Codex once it is signed in. Until then it is marked experimental on the Connect screen. |
| D22 | The core's A1 to A16 still pass. The only behavior changes are the ones in §5, and `docs/DESIGN.md` documents them. |

## 11. Test strategy

Test-first throughout. Write the failing test, make it pass simply, then refactor.

- **Core (vitest, `test/`):** schemas and gates for lessons, drafts and sources; the learner rules for `lesson`, `read` and deferral; `--tools` registration; progress events (Docker); learner file saves.
- **Desktop pure modules (vitest):** `flow.ts` (state to turn), `turns.ts` (tool lists, prompt length, success checks), `roadmap-edits.ts`, `events.ts` (recorded fixtures), `launch.ts` (argument arrays per OS), `resolve.ts` (folder lists per OS).
- **IPC:** handlers run against a fake `app`, asserting validation and that only view types come back. The D5 canary test lives here.
- **Renderer:** Testing Library tests per screen state, including the empty, failure and disconnected ones.
- **End to end:** Playwright drives Electron with a **fake agent**, a small script that speaks the Claude stream-json format and makes real calls to the bundled `codemm mcp`, so the whole journey runs in CI without a model. Docker tests run where Docker is available, as in the core.
- **Journeys** D18 to D21 run with real agents before release.

## 12. Deferred

- Spaced review, and the Review card.
- Signing, notarization, auto-update and store distribution.
- Persistent agent sessions (Claude's `--input-format stream-json`) and token-by-token streaming. One process per turn is enough for 1.0.
- Showing a track's Dockerfile before setup.
- Executable lesson examples.
- Windows and Linux on arm64.
- Podman in the desktop (the core already supports it experimentally).
- Placement quizzes, streaks and activity history.
- A recommended-model list (it comes from the bench).
- Multiple workspaces in the app.
- Localization.

## 13. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| O1 | Setup consent wording | Add one plain line to the dialog: "Setup runs your agent's install steps with internet access." The prototype's "Downloads once. Graded runs are offline." alone understates it. |
| O2 | How many tries one "yes" covers | One setup job: a turn plus one automatic retry, at most 3 saves each. Try again asks again. |
| O3 | Credential variables in the agent's environment | Pass the environment through unchanged. An API key the learner set is their choice, and "uses your plan" still holds. The other option is to strip known key variables so the subscription is always used. |
| O4 | The learner's own agent settings (hooks, plugins, global instructions) | Keep them, because it's their agent. The other option is to isolate tutor turns, for example with Claude's `--setting-sources`; the spike saw the user's hooks run inside turns. |
| O5 | The model when the agent's default is rejected | Show "choose another model" on the Connect screen, listing what the agent reports where it can (`cursor-agent --list-models`), with free text otherwise. |
| O6 | Workspace location | `~/Codemm`, which the learner can change at first run. |
| O7 | Windows support claim | Experimental unless someone runs D19 on a Windows machine before release. |
| O8 | Signing accounts | Needed before signed builds: an Apple Developer ID for notarization and a Windows code-signing certificate. |
