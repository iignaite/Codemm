# Codemm desktop 1.0 design

Status: trimmed to the owner-approved 1.0 scope (the scope ledger, 17 Oct 2026), after Astra's reviews (§14). It extends the core spec, `docs/DESIGN.md`, which stays authoritative for the harness. The core changes in §4 move into `docs/DESIGN.md` in the same PR as their code. The journeys follow the approved prototype (`codemm-journeys.html`, outside this repo). 1.1 adds several activities per topic and plain practice (core §2 "1.1 scope"): §3.2, §4.3, §4.5, §4.14, §4.15 and B6 to B11 in §9; it is specified and not built yet. Agent CLI evidence: [agent-bridge.md](agent-bridge.md).

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

- **Connect:** Claude Code and Codex, with a sign-in check. Codemm installs any of the three agents, and Docker, when they're missing (§3.1, §6.1). Cursor is experimental.
- **Check this computer:** the environment matrix in §6.1.
- **Learn:**
  1. Pick a goal, and the agent writes a roadmap; it may research first.
  2. Approve the roadmap, ask for changes, or edit it: rename, reorder, add or remove topics.
  3. Give one consent before setup.
  4. Read lessons, which are static text, and take notes.
  5. Do the activity: edit, Run (io), Try it, Check, and see the results.
  6. Ask the tutor, behind the reply filter.
  7. Skip honestly, and see progress and completion.
  8. *1.1:* go from one activity of a topic to the next without waiting, see which one this is, reopen past ones, ask for more practice, and skip a topic's lessons with "I know this" (§4.15).
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
- The connect screen says "Codemm uses your agent and your account." It promises nothing about billing, since Codemm can't tell a plan from an API key. Every agent job starts from a learner action or the approved flow, and the bounds in §3.2 cap how much it uses.

**Navigation.** The sidebar holds Learn (the course map), Practice, Tracks and Agent; beside a workspace it slims to icons, each named in its tooltip. Agent opens the connect screen (§3.1), where the learner can change agent at any time; Continue there comes back to the screen it left, through Check this computer, which moves on by itself when the computer is ready. The course editor comes back on its saved draft, so the edits made before are there. Practice is the activity of the topic Codemm offers now (a due or in-progress review first, as on the course map), and opens the activity screen, so it never lands in the lessons unasked; with no course it opens the goal screen, and with a finished course the map. Until the activity opens, that screen shows the topic's title and says why: "Practice opens after you finish the lessons." (with I know this, §4.3), "Practice opens once setup is done." or, with the job's progress (§4.11), "Practice opens here once your activity is written.", with Go to the lessons. It reads the course again until the activity opens or the course's work stops, then opens it and moves focus to its title.

## 2. Architecture

```
desktop/
  src/shared/api.ts         the IPC contract: channel names, input and output types
  src/preload/preload.ts    contextBridge exposes `codemm.*` from api.ts; nothing else
  src/main/
    boot.ts                 the entry point: one Codemm per profile
    main.ts                 window, app lifecycle, menu
    ipc.ts                  one handler per channel: check the sender, validate input, call one function, return a view
    views.ts                learner-safe projections of core results, and the reply filter (§2.2)
    state.ts                desktop.json in userData: chosen agent, executable path, tutor session ids
    agent/agents.ts         the agent CLIs (AGENT_CLIS), their shared types, and the tested versions
    agent/claude.ts, codex.ts, cursor.ts  per agent: launch arguments, stream parser, sign-in and version checks
    agent/stream.ts         the line-stream parsing the adapters share
    agent/bridge.ts         spawn, line parsing, cancellation, status commands (proved in spikes/agent-bridge)
    agent/jobs.ts           job kinds: brief, tools, deadline, retry bound, done check (§3.2)
  src/renderer/             screens only; no Node, no file or process access
```

- **Core in-process.** Main imports the core's `app` module from the repo and bundles it. `app` stays the only place that holds use cases, so the CLI, the MCP server and the app share them.
- **Two processes write course data.** These are main and the `codemm mcp` server that each agent job starts. The core's PID-based course, track and workspace locks already serialize them.
- **One server per job.** Each job's MCP server is the app's own binary in Node mode: `ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/core/cli.js mcp --workspace <ws> --course <course> --tools <list> --desktop`. The Electron `RunAsNode` fuse must stay on.
- **One Codemm.** Opening Codemm again hands over to the one already open, which shows its window, restored if minimized. A launch while Codemm is quitting opens it again once it has stopped, except during Restart to update, whose installer opens it. The second launch quits before it starts any job, install or cleanup: `boot.ts` loads `main.ts` only when it holds Electron's single-instance lock, which is per profile (userData). So one process owns userData and the workspace's jobs.
- **One workspace.** The app keeps one workspace (default `~/Codemm`) holding `codemm.json` and `exercises/`. The course, events and tracks stay under `$CODEMM_HOME`, as in core. `desktop.json` carries `format_version` and is written atomically, like every Codemm-owned file.

### 2.1 Renderer security

- **Window settings.** Windows set `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and load the app's own `app://codemm` origin.
- **CSP.** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. The page can make no remote request, including for images. The terminal pane works within it (§4.10).
- **Markdown.** Lessons and agent text are rendered with raw HTML stripped:
  - An image with a remote URL renders as a plain link.
  - Links keep only `https:` URLs.
  - Code blocks are shown, never run. In lessons, activity statements and Codemm's replies, highlight.js colors a fence's code when it knows the first word of its info string (§4.3). It escapes the code, adds only class names, and loads only for text with a fence that has an info string.
  - A diagram in a lesson is drawn to an image (§4.3), which runs no script and loads nothing. An inline drawing would need styles this CSP refuses.
- **Navigation.** Navigation, `window.open` and webviews are denied. `shell.openExternal` opens a link only after a click, and only for `https:` URLs.
- **IPC senders.** Every handler checks that `event.senderFrame` is the main window's top frame on `app://codemm`, and rejects anything else.

### 2.2 The learner-safe boundary

- **IPC.** Every IPC result is built in `views.ts` from core results that are already learner-safe: `getExercise`, `CheckView`, `progress`, `getRoadmap`, `getLesson`, `listTracks`, and the learner file reads. Hidden results carry only an index and a status, as in core §4.2.
- **Agent events.** Only `text` events from tutor and roadmap-change turns reach the renderer. For other jobs the renderer sees a job state: `running`, `done` or `failed`. Every job also sends its progress (§4.11): a stage, fixed step labels, web searches and pages, counts and times, never a tool's arguments or results.
- **Never forwarded.** Author, setup and lesson job streams, tool arguments and results, agent stderr, and status-command output.
- **Reply filter.** Before forwarding text, main compares it with the solution, mutants, hidden tests and expected outputs of every exercise in the course: the turn's own course for a tutor reply, whatever course is approved by the time it ends. It checks every exercise, because the tutor can open any of them. If any normalized line of at least 24 characters from that material appears verbatim, the message is replaced with "Codemm held back a reply that showed hidden material." If the material can't be loaded, nothing can be checked, so the message is held back too. Job steps, research pages and saved roadmap sources get the same check, and are dropped instead. This is a backstop, not proof: a paraphrase passes it.
- **Honor system.** As in core §1 and §4.2, grading is on the honor system, and hidden tests are hidden from the agent's tools, not from the computer. §3.1 says how much each agent can still read (decision 10).

## 3. The agent bridge

### 3.1 Launch, isolate, stream, cancel, sign in

Proved for Claude Code and Codex in [agent-bridge.md](agent-bridge.md). Cursor was proved with cursor-agent 2026.10.16-e3cb207 (it updated itself from 2026.01.23 at sign-in), signed in on the free plan: recorded fixtures and a canary run.

| | Claude Code | Codex | Cursor (experimental) |
|---|---|---|---|
| Headless turn | `claude -p <brief> --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check <brief>` | `cursor-agent -p --output-format stream-json --approve-mcps --trust [--model <m>] <brief>`, run in a job folder |
| Codemm server | `--mcp-config <json> --strict-mcp-config` | `-c mcp_servers.codemm.{command,args,env}=…` | `.cursor/mcp.json` in the job folder, `<userData>/agents/cursor-<config hash>` (no flag exists, and the workspace and `~/.cursor` stay untouched) |
| Codemm tools | `--allowedTools mcp__codemm__<tool>,…` | `-c mcp_servers.codemm.enabled_tools=[…]`, then `default_tools_approval_mode="approve"` | `.cursor/cli.json` in the job folder: `permissions.allow` `Mcp(codemm:<tool>)`, … |
| Built-in tools | `--tools ""` (web search and fetch for the research job only) | `--ignore-user-config`, `--disable shell_tool --disable unified_exec --disable browser_use --disable computer_use --disable apps --disable multi_agent`, `-c sandbox_mode="read-only"`, and `-c web_search="disabled"` except for research | The same file denies `Shell(*)`, `Read` and `Write` of `**` and `/**`, and `WebFetch(*)` except for research. Research adds `--force`, since print mode approves web search and fetch only with it |
| Follow-up turn | `--resume <session_id>` | `codex exec resume <thread_id>` | `--resume <chatId>` |
| Sign-in check | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in" | `cursor-agent status`, "Not logged in" |

**What isolation holds.** This was tested with a canary file the agent was asked to read (agent-bridge.md, finding 7).

- **Claude Code.** `--tools ""` leaves only the Codemm server's tools, with no shell and no file reads, and the canary wasn't read. The per-job `--tools` filter on the server (§4.6) narrows those to the job's own.
- **Codex.**
  - The read-only sandbox blocks writes and network, but not reads: with the shell on, `cat` of the canary succeeded. So the shell features are off.
  - `--ignore-user-config` drops the learner's own MCP servers and plugins. It also means Codex uses its default model, or the bench's recommendation (§8).
  - `enabled_tools` limits the Codemm tools, and `multi_agent` is off.
  - Code mode (`functions.exec`) remains, because Codex calls MCP tools through it. Whether it can read files is unproven. Hidden data is therefore protected by the reply filter and the honor system, under the reworded invariant (decision 10).
- **Cursor.**
  - It reads MCP servers and permissions from its working directory, and keeps chats per working directory. So each job runs in a Codemm-owned folder named by its config: the same config gets the same folder, and a tutor turn resumes its chat. `--trust` stops an untrusted folder from halting print mode.
  - The folder's `cli.json` allows only the job's Codemm tools. It denies the shell, file reads and writes, and web fetches outside research. Deny rules win over the learner's own allow list.
  - **What the canary showed** (a signed-in run asked to break out, with and without `--force`):
    - The shell, file reads and writes were denied, inside the job folder and outside it.
    - Grep returned no matches and glob no file names, though glob reported a file count.
    - Without `--force`, web search and fetch were rejected. With it, research could search and fetch, and the denials held.
  - Gaps, like Codex's (O8):
    - The learner's own MCP servers and plugins load, and `--approve-mcps` approves them. Their tools run only where the learner's own allow list permits, or in research, under `--force`.
    - Cursor's subagent tool (`task`) is not turned off. It runs under the same permissions.
    - Hidden data is protected by the reply filter and the honor system.
  - **No startup signal.** Cursor never reports that a server failed to start. Its tool lookup can't find the `codemm` namespace, or a call fails with "MCP server does not exist", and either becomes the server event (recorded).
  - **Errors.** They go to stderr, which is drained. Only a plan limit or a lost connection is read from it, as a fixed message.
  - **Models.** The free plan runs only Auto ("Named models unavailable"), so Auto is the one tested model.
  - **Plan limit (recorded).** On the free plan, stderr says "You've hit your usage limit", with no result event. Codemm shows the plan-limit state.
- **The invariant.** Codemm never runs agent-written code on the host, and runs untrusted code only through `sandbox.ts`. What the agent's own tools do happens under the agent's own sandbox, exactly as in a terminal. Turning those tools off is defense in depth.

**Running processes.**

- **Spawning.** Argument arrays, no shell, closed stdin (both CLIs otherwise wait on stdin), and each agent leads a new process group.
- **Windows' command-line limit.** The brief is one argument, and Windows takes at most 32,767 characters for a whole command line, which quoting can double. So on Windows a tutor brief carries at most 8 K characters of the learner's code (64 K elsewhere), and a setup brief at most 4 K of the failed proposal's problem (16 K elsewhere). A test builds each agent's worst-case tutor turn (every character a quote, a long `PATH`) and checks that it fits.
- **Cancelling.**
  - On POSIX: SIGTERM to the group, SIGKILL after 3 s, and the run resolves only when the group is gone.
  - On Windows: `taskkill /pid <pid> /t /f`, awaited.
  - A job that is already cancelled never starts.
  - If the group survives, or `taskkill` fails, the job fails with "Codemm couldn't stop your agent. Quit Codemm to stop it."
  - After an attempt Codemm ends (a cancel, the deadline, or a failure that stops the agent), the job awaits the core's leftover-container cleanup before it relaunches or finishes (`doctor --fix`'s rule: only containers whose owner is gone). If one is still there, a job that would relaunch fails as an infrastructure failure instead, and a job that stopped for its own reason (offline, a plan limit, a sign-out) keeps it. A runtime that is down runs no containers, so that cleanup succeeds; any other cleanup failure, a timeout included, counts as one still there. An agent that survived its cancel is reported at once, before any cleanup. The app also runs it at start and when quitting, for a crash.
- **Robustness.**
  - A stream line that is malformed or makes the parser throw is skipped.
  - A line over 1 MB is dropped before parsing.
  - Status commands (sign-in, `--version`) stop at 10 s, even if a child keeps the pipe open, and read at most 64 KB.
- **Streaming.** Each stdout line is parsed into common events: `session`, `text`, `tool_call`, `tool_result` and `done`. Both CLIs emit whole messages, not tokens.

**Credentials and environment.**

- Codemm never opens an agent's credential files or keychain entries.
- Sign-in uses the agent's own status command (`agent/signedIn.ts`). Only a yes, a no or "can't tell" leaves the bridge.
  - It is a no only when the agent says so: `loggedIn: false`, or "Not logged in".
  - A busy computer can take 20 s to answer (`claude auth status` took 8.5 to 21 s in a walkthrough). So a check with no answer in 10 s is asked once more, with 60 s.
  - A check that still doesn't answer, prints something else, or says no while the network is down can't tell. The agent isn't called signed out: an agent connected before stays connected, Connect connects, and the next look asks again. A job runs, and a failed job ends as a plain failure rather than a sign-out.
- Signing in uses the agent's own login, never Codemm. A signed-out row says "Sign in to Codex, then try again." with a **Sign in** button that starts that login where the learner sees it (`signIn.ts`):
  - Claude Code: in a Terminal window on macOS (a one-line `.command` file holding the quoted path). On Windows it gets a console window of its own: PowerShell opens it through the Windows shell (.NET's `Process.Start` with `UseShellExecute`), as a double-click does, with the path and arguments as environment variables. PowerShell itself runs hidden and not detached, since a detached program on Windows has no console at all. Started straight from Codemm, it would have no window, and its prompts would go nowhere. Windows opens it at once, so there is no gap for an install to replace the file, as Terminal's moment allows on a Mac.
  - Codex and Cursor: their login opens the browser.
  - Codemm never reads, stores or types credentials.
- **Looking again.** An agent installed, removed or signed in elsewhere (another window, a terminal, the browser) shows up within seconds, with no restart and no click. The connect screen looks for the agents every 3 seconds while it's shown (every half second while an install runs), and at once when the window regains focus. Welcome and Install what's missing look every 3 seconds until an agent is connected. Like every screen's timed re-read, a look waits while Codemm's window is hidden (minimized or covered), and runs once it shows again.
  - A look is cheap, but a sign-in check starts the agent. So a look checks an agent's sign-in again (a signed-out agent, or one whose check couldn't tell) only 5 seconds after its last check ended, whatever started that check. Connect, and a job's own check, always ask. A look or a job joins a check still running, so one agent never runs two at once; Connect waits for it and then asks again, since it may have started before the learner signed in.
  - The agent the learner tried to connect, or last asked Codemm to install, connects once it is signed in.
  - Once nothing is left for Install what's missing to install, it goes on to the connect screen.
- **Changing the agent.** Connect on another installed agent switches to it, and the one before shows Connect again. A running job keeps the agent it started with; the next job, and the tutor's next answer, use the new one. Tutor sessions are kept per course and agent, so switching back resumes the earlier conversation. Background work stopped because the agent signed out starts again once an agent is connected, whether by Connect or by a look that finds it signed in elsewhere, so the course never sends the learner back to Connect.
- The agent gets the app's environment unchanged (decision O1).

**Finding and launching agents.**

- Claude Code on Windows doesn't need Git for Windows. Since 2.1.120 it uses PowerShell when Git Bash is missing (its changelog; its setup page calls Git for Windows optional), and Codemm turns its shell tools off anyway (`--tools ""`). The tested version, 2.1.283, is later, so Codemm doesn't check for `bash.exe`.
- GUI apps don't load shell profiles. The app looks on `PATH` and in the usual install folders, including where Node version managers put npm-installed CLIs: Volta, nvm (its default version first, then the newest) and fnm's default, and where the vendors' installers put the agents (`~/.local/bin`; on Windows, `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, WinGet's command links in `%LOCALAPPDATA%\Microsoft\WinGet\Links` and `%ProgramFiles%\WinGet\Links`, since Claude Code's and Codex's WinGet packages are portable, and Cursor's `%LOCALAPPDATA%\cursor-agent`, whose `cursor-agent.cmd` starts PowerShell and so isn't run yet). For `docker`, it also looks in Docker Desktop's, OrbStack's and Rancher Desktop's folders (`/Applications/Docker.app/Contents/Resources/bin`, `~/Applications/Docker.app/Contents/Resources/bin`, `~/.docker/bin`, `~/.orbstack/bin`, `~/.rd/bin`; on Windows, `%ProgramFiles%\Docker\Docker\resources\bin` for all users and `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` for one, Docker's default since 4.83) and Podman's installer folder (`/opt/podman/bin`); Colima uses the Docker client from Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), which is searched too. GitHub's Windows runner confirmed the per-user CLI folder: Docker's per-user install puts `docker.exe` there and adds it to the user `PATH`, and WinGet's links are symlinks in a folder it adds to the user `PATH`. On the connect screen the learner can pick the agent's executable.
- **Installed while Codemm is open (Windows).** A process keeps the environment it started with, and installers add their folder to the `PATH` in the registry, so a running Codemm would miss them until it restarted (`app.relaunch()` and Restart to update inherit the old environment too). So before Connect's list, Connect, Check this computer and each job's start, Codemm reads the machine's and the user's environment keys (`C:\Windows\System32\reg.exe query <key>`, argument arrays, no shell) and adds the folders its own `PATH` lacks: the machine's, then the user's, ignoring case and a trailing backslash (`agent/livePath.ts`).
  - It expands `%NAME%` in REG_EXPAND_SZ values, ignoring case, as Windows builds a new process's environment: over Codemm's own variables come the machine's, then the user's, each key's REG_SZ values before its REG_EXPAND_SZ ones, and each `Path` last. So a variable an installer defines beside its `Path` entry while Codemm is open (nvm-windows' `%NVM_HOME%` and `%NVM_SYMLINK%`, Chocolatey's `%ChocolateyInstall%`, pnpm's `%PNPM_HOME%`) expands too. A folder whose `%NAME%` nothing defines names no folder, so it's left out, and no literal `%NAME%` reaches `PATH`. A REG_SZ value is plain text.
  - It writes `process.env.PATH`, so agent jobs and core's docker calls inherit it.
  - It only adds: what `PATH` had stays exactly as it was, in its order, Docker's folders added at start included.
  - Calls at the same time share one read, and a read under 2 seconds old is reused. A read that fails, or takes over 2 seconds, keeps the `PATH` as it is, so no screen waits on reg.exe longer than that. After a read that hung or threw, the next waits 30 seconds, so polling screens don't wait each time. The clock is monotonic. `find` itself stays synchronous.
  - The packaged and install tests stage a `PATH` with no Node, npm or Git, so they set `CODEMM_TEST_FIXED_PATH`, which turns the refresh off.
  - A managed PC's policy can make reg.exe refuse even to read ("Prevent access to registry editing tools"). The `PATH` then stays as launched: the fixed folders above still find every vendor's install, and a restart picks up the rest. A PowerShell fallback is deferred (§12).
  - reg.exe writes in the console's code page, so a folder whose name has non-ASCII letters can be misread, and one it can't spell is left out. The vendors' own folders above come from the environment, so they don't depend on it.
  - macOS needs none of this: a GUI app gets no shell `PATH` there, and the usual folders cover every vendor's install.

**Installing an agent for the learner** (`desktop/src/main/agentInstall.ts`). On macOS and Windows, a missing Claude Code, Codex or Cursor row offers **Install** and **Get it myself** (the official page). Install is the vendor's own user-level install: no Node, npm or admin rights.

- **Downloads.** Only from the vendor's https host, checked at every redirect hop before it is followed: `downloads.claude.ai` for Claude Code; `releases.openai.com` (where `chatgpt.com/codex/install.*` redirects) for Codex; `cursor.com` for Cursor's script. Nothing is a `curl | sh` string; every command is an argument array.
  - Codemm names itself `User-Agent: Codemm`, not Electron's browser string: `cursor.com/install` answers a browser with a redirect to a web page, not the script.
  - They go through Electron's network stack (`net.request`, `download.ts`), so the system's proxy settings and certificate store apply, as in a browser. Node's own `fetch` ignores both.
  - There is no total deadline. A download with no bytes for 60 seconds, or one that loses the network midway, is offline. A disk that can't save it, a size cap or an HTTP error is a plain failure.
  - The download is for this computer's own chip. An x64 build of Codemm under Rosetta, or under Windows' x64 emulation on Arm, reports x64, so Codemm asks Electron (`app.runningUnderARM64Translation`).
- **Claude Code.** Codemm does what Anthropic's `install.sh` and `install.ps1` do, without running a script, so the binary is checked before it runs:
  1. It reads the latest version and that release's `manifest.json`.
  2. It downloads the platform's binary and requires its SHA-256 to match the manifest.
  3. It requires Anthropic's signature. On macOS, `/usr/bin/codesign --verify --strict` with the requirement `anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"`: an Apple-issued certificate for Anthropic's team, not just a valid signature. On Windows, Authenticode `O="Anthropic, PBC"`, with the path passed as an environment variable.
  4. It runs the binary's own `install`, which puts the launcher in `~/.local/bin`.
  - Downloads are capped per file: 1 KB for the version, 1 MB for the manifest and the scripts, 2 GB for a binary.
- **Codex.** OpenAI's install script is about 1,300 lines (release-asset SHA-256 checks, its package layout, PATH setup), so Codemm runs it rather than re-implement it: `/bin/sh <file>` on macOS, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file>` on Windows, with `CODEX_NON_INTERACTIVE=1`. The script itself verifies its download's SHA-256. Afterwards Codemm requires OpenAI's signature on the installed binary: Apple team `2DC432GLL2` (the same Apple-anchored requirement), or Authenticode `O="OpenAI OpCo, LLC"`. That check comes after the script ran, so it is defense in depth, not a gate. OpenAI publishes no checksum or signature for the script itself.
- **Cursor.** Codemm runs Cursor's own install script, as its docs do, but as a file: `https://cursor.com/install` saved and run as `/bin/bash <file>` on macOS (the script uses bash's `[[ ]]`), `https://cursor.com/install?win32=true` saved and run as `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file>` on Windows. Never `curl | bash` or `irm | iex`. The script itself downloads Cursor's package from `downloads.cursor.com`, so Codemm checks none of those hops, and installs it into `~/.local/share/cursor-agent` (linked from `~/.local/bin`) or `%LOCALAPPDATA%\cursor-agent` (added to the user's PATH).
  - **Weaker than Claude Code's or Codex's check.** Cursor publishes no checksum, its script checks none, and nothing in the package is signed by Cursor. What Codemm checks, after the script ran, is the Node.js that runs Cursor's code: on macOS, the `node` beside the launcher `cursor-agent` links to, signed by the Node.js Foundation (Apple team `HX7739G8FX`); on Windows, the `node.exe` that Codemm starts Cursor with, Authenticode `O=OpenJS Foundation`. Both were read from Cursor's 2026.10.22 package. That proves Cursor's package holds a genuine Node.js, not that its JavaScript is Cursor's, and it comes after the script ran (on macOS the script may run the new `cursor-agent --version` itself), so it is defense in depth, not a gate. The guarantee is the https host, as when the learner pastes Cursor's command. If Cursor ever starts its code some other way (its package already holds an unsigned `cursor-agent-sea`), this check fails closed: the install is unverified until Codemm follows.
  - Cursor's Windows script doesn't stop on errors, so it can exit 0 after a failed download. Codemm counts the install as done only once it finds `cursor-agent` where it looks (on Windows, Cursor's own `node.exe` and `index.js`), and reads the script's output only for signs of being offline.
  - **The version the script names.** Before running it, Codemm reads the version the script installs (`$version = '…'` on Windows, `FINAL_DIR=…/versions/<v>` on macOS). A script that names none doesn't run. Afterwards the Cursor Codemm finds must be that version's folder. A copy an earlier run left (on Windows, a locked `node.exe` can outlive the script's delete while its download fails and it still exits 0) is a failed install, not a pass.
  - The script's output is never shown. Its "Git for Windows ... is required to run a private worker" line is about a Cursor feature Codemm doesn't use: Codemm's Cursor jobs deny the shell.
  - The script replaces `%LOCALAPPDATA%\cursor-agent` and edits the user's PATH; that is Cursor's own way.
- **Nothing unverified runs.** Once Codemm starts installing an agent, it runs nothing of it this session until an install is done. Any failed attempt keeps it blocked, since it may have left a binary nothing checked, and a later failure never clears an earlier rejection. Nothing starts: not `--version`, the sign-in check, Sign in, a job or its relaunch, each checked right before it starts. Claude Code's Sign in on a Mac runs in Terminal a moment later, so its script runs only the file Codemm allowed when the learner clicked, never one an install put there since. Try again installs again. An agent the learner installed themselves is theirs to trust, as in a terminal; so is a leftover found after a relaunch, since the install's state isn't kept.
- **Verified against real releases.** The Windows signers were read from Anthropic's `claude.exe`, OpenAI's `codex.exe` and the `node.exe` in Cursor's Windows package. An opt-in test (`agentInstall.real.test.ts`) downloads Claude Code's binary and Codex's and Cursor's scripts for real and checks them without installing (Cursor's package only through an already installed Cursor).
- **States.** Downloading (with progress), checking, installing, then done or a plain reason: offline, low disk (1 GB), unverified ("Codemm couldn't verify the installation. Try again.", which claims nothing about what ran), or the installer didn't finish, each with Try again. An agent Codemm installed gets its sign-in check at once, and connects once signed in.
- **Never automatic.** Large downloads and third-party terms wait for the learner's click.
- **Limits.** Offline is read from a script's output in English only; in another language a script that couldn't reach its host is a plain failure, with the same Try again. The scripts' own downloads (`curl`, `Invoke-WebRequest`) don't go through Electron's network stack, so a proxy set only in the system's settings may not apply to them, for Codex as for Cursor.
- A native executable runs directly.
- A JavaScript entry point (a `#!/usr/bin/env node` launcher, like the npm-installed Codex) runs as `ELECTRON_RUN_AS_NODE=1 <app executable> <script>`, so no system Node is needed.
- On Windows, an npm `.cmd` shim is never run, because that needs a shell. The app reads what the shim runs from npm's fixed format, the quoted path just before `%*`: a script runs the same way, and a native binary runs directly. Claude Code's npm package is one: its `bin` is `bin/claude.exe`. That file is a text placeholder until the package's postinstall replaces it, so a binary counts only if it starts with `MZ`; otherwise the search goes on, to `~/.local/bin` say.
- **Cursor on Windows** (`agent/cursorWindows.ts`). Cursor installs to `%LOCALAPPDATA%\cursor-agent`. There, `cursor-agent.cmd` runs Windows PowerShell 5.1 on `cursor-agent.ps1`, which runs `versions\<v>\node.exe` on `versions\<v>\index.js`.
  - Codemm runs neither launcher. Node won't start a `.cmd` without a shell, and Codemm uses none. Through cmd and PowerShell 5.1, a multi-line brief would be cut at its first line, its `%VAR%` and `!` expanded and its quotes dropped.
  - So a `cursor-agent.cmd` that isn't an npm shim becomes Cursor's own `node.exe` running its `index.js` (chosen below), started directly, as Cursor's staff advise. The lookup (`find.ts`) does this for a `cursor-agent.cmd` in any folder it searches, `%LOCALAPPDATA%\cursor-agent` among them. It's Cursor's Node, not Electron's: Cursor ships native modules built for it. Codemm sets what the launcher sets: `CURSOR_INVOKED_AS=cursor-agent.cmd`, and `NODE_COMPILE_CACHE=%LOCALAPPDATA%\cursor-compile-cache` unless one is set. Sign in runs `login` the same way. (Cursor's macOS launcher adds `--use-system-ca`; its Windows one doesn't, so neither does Codemm.)
  - **Version choice**, as `cursor-agent.ps1` makes it: a `node.exe` and `index.js` beside the launcher, else the newest folder named `YYYY.M.D-<hash>`, or with a `-HH-MM-SS` build time, by date. Its order within a day is unspecified, so Codemm uses the build time, then the name. Staged `.new` and `.previous` folders don't match. Unlike the launcher, Codemm passes over a folder without both `node.exe` and `index.js`. With no such folder, Cursor isn't installed. This is read from the launcher of 2026.10.22-27dcf5f on a GitHub Windows runner; **to confirm on a real Windows PC**.
  - **Known limitation:** both launchers first run `versions\promote-staged.cmd`, which promotes a staged self-update. Codemm never runs it, so a staged update waits until Cursor next runs from a terminal, and Codemm runs the current version meanwhile.
- The same lookup adds Docker's folder to `PATH` for core calls.

### 3.2 Jobs

| Job | Codemm tools | Done when |
|---|---|---|
| Research and roadmap | `list_tracks`, `save_roadmap` | the job's course exists |
| Roadmap change ("Ask Codemm for changes") | `get_roadmap`, `save_roadmap` | the course record changed, or the turn ended without error and without a save (shown as "No change" with the agent's text) |
| Setup | `list_tracks`, `save_track` (proposes only) | a new proposal exists for the job's track |
| Lesson | `get_roadmap`, `save_lesson` | a new lesson exists for the job's concept |
| Author | `next_step`, `save_exercise` | a new exercise exists for the job's concept and difficulty; for an ahead or More practice job, a new exercise exists for its concept (its difficulty can move with the learner's checks) |
| Tutor | `progress`, `next_step`, `get_exercise`, `get_lesson`, `mark_lesson_read`, `get_roadmap`, `list_tracks` | the turn ends without error |

- **Bound to a course.** Every job's server gets `--course <course>`, so switching courses in the app can't redirect a job's save.
- **Checking the result.** "Done when" is checked against core records created after the job started, never against the agent's text. Before relaunching a failed job, main checks again, because a save can commit just before a crash.
- **Fresh sessions.** Author, setup and lesson jobs start without history, which is cheaper and keeps the author's work out of the tutor's chat. The tutor resumes one session per course, from the same workspace folder, because both CLIs keep sessions per working directory.
- **Concurrency.** At most two agent processes run at once per course: one foreground job and one background queue (§4.13). After approval, the first lesson runs in the foreground while setup, then authoring, runs in the background.
- **Author targets come from core** (1.1). The app never builds a target; it starts an author job for one core names, and the job's agent reads it from `next_step`:
  - **Next:** an `author` step. The brief adds no request.
  - **Ahead:** a `practice` step with `ahead` (core §7), once the track is installed. The brief asks `next_step` for `ahead`. The job is keyed by its concept and difficulty, like the `author` step it stands in for, so a pass while it runs starts no second job and Continue waits on this one.
  - **More practice:** the learner's request on a topic (§4.15). The brief asks `next_step` for `more` with the topic.
  - **Still wanted.** When an author job's turn comes (it may wait behind another job, or another course's author), it launches only if core still names its target: the step's `author` target, the step's `ahead`, or for More practice an `author` answer to `more`. Otherwise it ends without starting an agent and stalls nothing.
  - These are all author jobs, with the author's bounds below. At most one runs per course at a time, in the background queue.
- **Bounds.**

  | Job | Deadline | Retry bound |
  |---|---|---|
  | Research | 10 min | — |
  | Setup | 10 min per proposal, then core's 10 min build limit | 5 proposals per setup |
  | Lesson | 5 min | 3 failed `save_lesson` calls |
  | Author | 15 min | 3 failed `save_exercise` calls |
  | Tutor | 5 min | — |

  The bridge counts failed saves from `tool_result` events and cancels the job at the bound. A failed job is relaunched once at most, and never when the failure is an infrastructure failure or a plan limit (§6.1). After that, the learner gets the failure screen (§5).
- **Practice protection.** Tutor turns have no edit tools in Claude Code or Codex. The learner edits; Codemm explains. This doesn't depend on the Claude hook, and it is not a security boundary (§3.1).
- **Stuck.**
  - "Reread the lesson" opens the lesson.
  - "Try an easier one" runs a roadmap-change job that adds a prerequisite topic. The stuck topic waits for it, then gets a fresh start (§4.2).
  - "Come back later" is skip (§4.4). It shows only when another topic is ready, since otherwise the same topic would come straight back.
  - The failed results stay under these ways forward.

### 3.3 Agent CLI versions and the minimum model

- **Tested versions.** `agents.ts` lists the CLI versions the recorded fixtures come from: Claude Code 2.1.283 and Codex 0.156.1 so far, and none for Cursor.
- **Startup check.** At startup and on the connect screen, the app runs `<agent> --version` as a status command. A listed version, or a later release of a listed major, is tested: agents update themselves and Codemm installs the maker's latest, so exact pins would call nearly every learner's agent untested, and pinning old versions would skip the makers' security fixes. Another major, a version older than the oldest listed, or a prerelease shows "Untested version. It may still work." on that agent's connect row. It never blocks.
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
  - "Show the files" opens the Dockerfile and track.yaml, the 10-minute build limit, and the fact that builds have no memory or CPU limit.
  - The topic page opens it. A lesson offers it as a "Set up React" banner, so reading never waits for consent.
  - A setup failure shows above the topic's lessons, which stay readable.
- **Retries.**
  - **Build failure from the learner's machine.** If a build fails because the machine is offline or out of disk space (§6.1), nothing is recorded and no agent runs. Try again re-installs the same proposal, which needs no new consent because the digest is unchanged.
  - **Gate failure.** If the gates fail, a new setup job gets the gate diagnostics, which hold no learner secrets, and proposes again within the bound in §3.2. A new proposal has new contents, so it asks again: "Codemm has another way to set up React." with Not now or Set up. Its text starts with why the last try failed, in Codemm's words from the failed gate's name alone, never its output: "The last try didn't build.", "The last try built, but its tests didn't work.", "The last try's files weren't valid." or "The last try didn't pass Codemm's checks."
- **Outside the app.** Without `--desktop`, `save_track` behaves as in core: approving the call in the agent is the consent.

### 4.2 Roadmap draft and edits

- **Draft before setup.**
  - `save_roadmap` accepts a track that isn't installed yet, if it is a valid `id@version`.
  - `next_step` returns `{ kind: "setup", track }` until it is installed.
  - Re-saving may change `track` while the course has no exercises, so a failed setup can move to another track. Before that save, main cancels the old track's setup and author jobs and drops its proposals. Lessons stay, because they are static text.
  - `save_exercise`, `get_exercise` and `check` still need the installed track.
  - If the installed track doesn't offer the roadmap's style, `next_step` fails with "Edit the roadmap's style".
- **A new roadmap is a draft.** Research saves a new course, which core makes the workspace's active one. The course the learner approved stays their course: main binds every learner read and call to it (core's `bound` course) until the learner approves another roadmap or switches courses (§4.13). The goal screen says a goal "isn't set up yet" only once typing pauses for 600 ms, so it never names half a word. It offers "Resume roadmap" for a draft, and the learner's edits to it are saved as they happen, so leaving or closing Codemm keeps them.
- **Reading.** `get_roadmap` (tool) and `app.getRoadmap(ws)` return `{ course, title?, goal, track, style, concepts: [{ id, title, requires }] }`.
- **Editing in the app** builds a new roadmap and saves it through `app.saveRoadmap`, so core §5 rules apply:
  - Rename changes the title only; the id stays stable.
  - Add creates an id from the title (kebab case, made unique) with `requires: []`.
  - Move changes order only. It is refused, with "Needs ‹title› first.", when it would put a topic above one it requires. Move works without dragging.
  - Remove is refused when another topic requires it ("‹title› needs this topic."). Core also rejects removing a concept that an exercise, event or lesson uses; the lesson part is new. Prerequisites are never rewritten silently.
  - Prerequisite changes go through "Ask Codemm for changes".
  - While "Ask Codemm for changes" or Go deeper runs, the learner's own edits wait: rename, remove, move, drag and add are off, and an open rename closes unsaved. Codemm changes the roadmap as it stood, so its result never overwrites an edit made meanwhile.
  - Go deeper keeps the learner's title on the topic it splits. The request asks the agent to keep the topic, with its id and title, as the first piece; if the result keeps the id but retitles it, the app puts the learner's title back and saves the draft.
- **The editor screen.** The topics scroll above a footer of their own, which holds the change's progress (§4.11), Codemm's reply or a refused edit's reason, "Ask Codemm for changes" and Approve. Nothing covers them, however long the roadmap. The footer takes at most half the window and scrolls past that, so a long reply never pushes Approve out of reach. In a window under 560 CSS px tall (200% zoom on most windows) the footer joins the page's flow instead. Each row says "Go deeper" in words; move, rename and remove are icons named on hover.
- **A fresh start after a new prerequisite.** When a re-save adds a prerequisite to a concept that is stuck, `save_roadmap` appends `{ kind: "retry", at, concept }`. Replaying a `retry` resets that concept's fail streak and leaves mastery unchanged. Without it, the concept would be stuck again as soon as the new prerequisite was mastered.

### 4.3 Lessons

- **Saving.** `save_lesson { id, concept, title, markdown, examples? }`. The id is new in the course, the concept is in the roadmap, and the Markdown is at most 64 KB. Optional runnable examples are checked by running them in the sandbox (core §5).
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
  The activity stays locked, and the tutor teaches first, until the field is absent. The topic page and the lesson outline say why in words: "Opens after you finish the lessons". The author job can still run in the background, because the step names the activity. Lessons never change mastery.
- **I know this** (1.1). While the current topic's activity waits only on its lessons, the topic page, the lesson outline and Practice's waiting screen (§1) offer "I know this". It calls `unlockActivity(concept)`, which records core's `unlock` once (core §7), and then the activity opens, or Practice waits with its job's progress while it is still being written. The lessons stay in the outline, readable and unread, and a lesson still being written goes on. Nothing about mastery changes. There is no confirmation: nothing is lost, and the lessons stay.
- **Diagrams.** A top-level fence whose info string is `mermaid` is a diagram or chart: a flowchart, sequence, state or class diagram, a pie chart or an xy chart. The lesson screen draws it where the author placed it, and core only stores it (core §5).
  - **Local.** [Mermaid](https://github.com/mermaid-js/mermaid) (MIT) is bundled and loaded only when a lesson has a diagram; a lesson without one loads none of it. Nothing is fetched. Mermaid's default layout is ELK; Codemm sets dagre, and stubs out `elkjs` (`vite.config.mts`), the one bundled library under the EPL rather than MIT, ISC, BSD or Apache.
  - **Safe.** The source is agent text. Mermaid draws it at its strict level (labels encoded, no callbacks) with the sizes capped, and directives in the source can't change the security level, the sizes, HTML labels, the theme, the layout or the font. The drawing is shown only as an `<img>` of a `data:` URL, which runs no script, follows no link and loads nothing, and links, pictures, frames and scripts are also dropped from it. A source over 20,000 characters isn't drawn. The CSP stays as it is; mermaid's attempts at inline styles while it measures text are refused and show as notices in DevTools.
  - **Styled.** The light palette and Atkinson Hyperlegible Next, which travels inside the image, since an image can't use the page's fonts. The image has its natural size and never exceeds the page.
  - **Accessible.** The image's text alternative is the diagram's `accTitle` and `accDescr` (the brief asks for both). Without them it is the source.
  - **Broken.** A diagram that doesn't draw shows its source as a code block under "This diagram didn't draw. Here is its source." The rest of the lesson reads as usual.
  - **Cached.** A drawing is kept, so a reopened lesson shows it at once (the lesson itself comes from the cache above).
  - **Notices.** The renderer build writes the licenses of everything it bundles, mermaid and its dependencies included, to `licenses.md`; the installers carry it in their resources (`licenses.md`), as they carry the font licenses.
- **Code.** A fence's code is colored as the editor's is (§4.10): the first word of its info string is data that highlight.js's own table decides on, as a file's extension is in the editor, so `js` and `python` are colored, and an unknown or empty info string, indented code and a fence over 32 KB stay plain. Codemm names no language (A1, D15).
  - **Loaded on demand.** highlight.js loads only for a lesson with a fence that has an info string; a lesson without one loads none of it. Until it arrives, the code shows plain.
  - **Safe.** highlight.js escapes the code and adds only class names, which `app.css` styles under the CSP. Each token color reaches AA (4.5:1) on the code block's background. Raw HTML stays stripped (§2.1).
  - **Not code.** A top-level `example` or `mermaid` fence is still an example or a diagram, as above.
  - **Statements and replies.** An activity's statement and Codemm's replies color their code the same way. They render again only when their text changes or highlight.js arrives, not on each keystroke in the editor or the rail.
- **Not verified.** Lesson text is checked for structure only, and examples only for a clean run. Only activities are "checked before you see it".
- **Run.** Each example block shows its files and a Run button, and the example runs in the sandbox, never on the host, recording nothing. An io example runs as an activity's Run does (§4.10): `runExampleLive` through IPC, in the terminal pane with typed input and a countdown, and Run turns into Stop. A unit example runs once as tests through `runExample`, showing the output and errors (capped). `lesson` names the examples' style. A problem on this computer shows "This didn't run.", why, and what to do next: "Open Docker Desktop, then run again.", "Free up disk space, then run again." or "Connect to the internet, then run again." (`RUN_AGAIN` in `shared/api.ts`). A missing image already says to rebuild under Tracks.
- **Next on the last lesson.** While the topic's activity is still being written, "Your activity is almost ready" ("review" for a review) sits beside Next, which leads to it. The outline already shows how far the writing is.
- **The page never scrolls.** A workspace's columns share one row as tall as the window, so a long column, such as a long tutor chat, scrolls inside itself, and the chat follows its newest message by setting its own scroll position (never `scrollIntoView`, which would scroll the page). The window clips, so no `scrollIntoView` can move the top bar or the sidebar. In the stacked layout under 1000 px the workspace itself scrolls.

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
- **Continue after a pass.** A passing Check says "You mastered ‹topic›." or "Keep practicing ‹topic›." with Continue, ending once when the title has its own ? or !. When the topic Codemm offers now is a review (due or in progress, §4.14) or the same topic while its mastery needs more passes, Continue opens Practice, fresh, never under the last one's result, and while that activity is written Practice waits with its job's progress (§1, §4.11) and opens it by itself. For another topic it goes where the course map's Continue goes (core §7). Since 1.1 the next activity of a topic is usually written by then (ahead, §3.2), so Practice opens it at once. A finished course opens its celebration. A sidebar item that leads to the screen on show does nothing, so it never resets that screen.

### 4.6 Per-job MCP server

`codemm mcp` gains two options:

- `--course <course>` makes course-scoped tools use that course instead of the workspace's active one.
- `--tools <list>` registers only the listed tools.

With neither option, the server behaves as in core.

### 4.7 Reviews

Core §7 schedules reviews of mastered concepts at 1, 3, 7, 21 and 60 days. In the app:

- **Due.** A due review shows as "Review" on the course map and the topic page, and the activity opens with a "Review" label. If no unused exercise fits, an author job writes one (`review: true`), shown as the review being written. A review comes due with time, not with a learner action, so reading the course starts that job when it isn't running (an exception to D9's "reads start nothing", which is about reopening saved work). The course map and topic page re-read the course when the window regains focus, and every 10 minutes once settled, so a review that came due while the app was open shows up.
- **Scheduled.** The course map, beside the mastered topic on its path, and the completed-course screen show "Review tomorrow" or "Review in N days" for a mastered topic. They never show dates. Overdue reviews wait their turn behind the one being offered, without a countdown.
- **Outcome.** A review is an ordinary Check. A pass keeps the topic mastered; a fail sends it back to practice.

### 4.8 Check progress

- **Core.** `testExercise` and `checkExercise` take an optional callback with `{ phase, done, total }` (core §4.2).
  - io reports each visible test as it finishes; the build, when the track has one, shows once as `building`.
  - Hidden tests and unit tests report their phase only (`total` 0): no names, counts or timing per hidden test.
- **Desktop.**
  - The renderer passes a run id with each Try it or Check. `live` tags that run's events with it and keeps only `phase`, `done`, `total` and, for a visible io test as it finishes, `test` (name, status, message, output; core §4.2). A hidden event never carries a test, in `live` or in the preload.
  - Main sends each event to the app's windows only, on the one-way channel `codemm:check-progress`.
  - The preload exposes it as `onCheckProgress(listener)`, which returns a function that stops listening. It isn't an IPC call: `invoke('onCheckProgress')` is refused.
- **Renderer.** While Try it or Check runs, the results panel shows a quiet bar with the phase and "3 of 8". With no count, it shows the phase alone. It hears only its own run's events, and stops listening when the learner leaves.

### 4.9 Research sources and progress

- **Progress.** The stream parsers in `agent/claude.ts` and `agent/codex.ts`, with the shared steps in `agent/stream.ts`, read both CLIs: Claude Code's `WebSearch` and `WebFetch` tool uses, and Codex's `web_search` items (queries and `open_page`). It emits `search` (a query, at most 120 characters), `read` (https only, shown as host and path) and `step` (a fixed label for each Codemm tool, such as "Saving the roadmap"). Nothing comes from a file path, a file's contents or Codemm's records. The research job's steps travel with its progress (§4.11). The research screen lists them quietly, the latest first and fading as they age, with a step count.
- **Reads become sources.** When research has saved the roadmap, the https pages it read join the agent's own `sources` (at most 10), saved through core's roadmap rules.

- **Saving.** The research job lists the roadmaps and docs it used as the roadmap's optional `sources` (core §5). A roadmap change keeps them unless asked otherwise, and the app's own roadmap edits carry them over.
- **Showing.** The roadmap and course-edit screens show a quiet "Sources" line under the heading, so a long roadmap never pushes it out of view. Each link opens only after a click, in the system browser, through main's `shell.openExternal`, and main accepts only https links. Nothing loads inside the app window.

### 4.10 Run and the terminal pane

- **Toolbar.** An io activity reads **Run · Try it · Check**. A unit activity has no Run: its track has no run command. Only Check is graded.
- **Core.** `runInteractive` runs the learner's program through `src/sandbox.ts` only (core §4.3 "Run"). It uses the full flag set plus `-i`, network none, only the learner's files, a 60 s build and a 120 s run. It reports when each stage starts, with that stage's limit, and records nothing. `get_exercise` names the run command for io.
- **Desktop.**
  - `runProgram(activityId, run)` resolves when the program ends, with `ran` (exit, stage, timed out, stopped, flooded, out of memory) or `not-run` (a Docker problem, in Check's words). The terminal's last line adds the same next step as a lesson example.
  - `runExampleLive(lessonId, index, run)` is the same for a lesson's io example (core `runExampleLive`, which checks the example against the track it was saved with).
  - `sendRunInput(run, text)` and `stopRun(run)` act on either. A run stopped while Docker is starting ends at once, frees its place and never starts. One write is at most 64 KB, as core takes, and at most 4 programs run at once.
  - Output travels on the one-way `codemm:run-output` event as `{ run, stream, text }`, or `{ run, started, limitMs }` when a stage starts. The preload exposes it as `onRunOutput`, and `invoke('onRunOutput')` is refused.
  - **Window-bound** (`main/runs.ts`). A run belongs to the window that started it, from the call until it settles. The run id is the start call's last argument. Only that window hears its output; input or Stop from another window does nothing; closing the window stops it; quitting stops every run.
- **The pane** (`renderer/ui/Terminal.tsx`, shared with lesson examples).
  - A dark, monospace xterm.js screen (MIT) headed "Terminal", with a status on the right: "Building", "1:52 left" or "Time's up". It shows the command after a `$` prompt, keeps ANSI colors, and shows stderr in the error color. Every palette color reaches AA on the pane's navy.
  - The program reads a pipe, not a terminal, so the pane is a line editor: it echoes typing, honors Backspace, and sends each line with its newline. Ctrl+D ends the input, as in a terminal (Windows too: the pane isn't a console), so a program that reads until the end can finish; while a program reads, "Ctrl+D ends input." sits under the pane. Tab and Shift+Tab always move focus, so the pane never traps the keyboard.
  - A visually hidden log mirrors the plain text (the last 20,000 characters) for screen readers, and the input is named for its pane.
  - **CSP.** xterm.js writes its layout into `<style>` elements, which `style-src 'self'` blocks. The CSP stays as it is; the pane copies only its own style elements' rules into constructed stylesheets, which the CSP doesn't govern.
- **Renderer.** The pane appears with the first Run, between the editor and the results, and focus moves into it. Run turns into Stop on the same button, so focus stays put. Codemm's last line says how the program ended in words, never an exit code: "The program ended.", "The program ended with an error.", "The build failed." or "Time's up. The program was stopped after 2 minutes." Leaving the screen stops the program.
- **Test results show in one place: Results.** Try it and Check never write to the pane, which stays Run's, so it never repeats a test report. Results shows a wrong output's expected and found on their own lines, each scrolling when it's long. Learner-facing text names the learner's own files (`solution.py`, not the sandbox's `/work/src/solution.py`) and says how a program ended in words, not exit codes.
- **The editor** (`renderer/features/practice/Editor.tsx`): file tabs, line numbers and a textarea, which stays the one control the keyboard and a screen reader use.
  - **Colored by the file's extension.** [highlight.js](https://github.com/highlightjs/highlight.js) (BSD-3-Clause) colors the code. The editor asks it about the file's extension, or the file's name when it has none (`main.py` asks about `py`). When highlight.js's common build (about 35 languages) knows that as one of its languages or their aliases, the file is colored; otherwise it stays plain. Codemm names no language: the extension is data that highlight.js's own table decides on, so every file takes the same code path (A1, D15).
  - **Loaded on demand.** The library is its own chunk, loaded with the first editor, or with the first lesson, statement or one of Codemm's replies that has code to color (§4.3); nothing else loads it. Until it arrives, and for a file over 32 KB (coloring runs on each keystroke, and 32 KB takes about one frame), the text shows plain.
  - **Drawn under the textarea.** The colored copy sits under the textarea, whose own text is then transparent, with its caret and a see-through selection. The copy is hidden from screen readers, takes no input and scrolls with the textarea. highlight.js escapes the code and adds only class names, which `app.css` styles under the CSP's `style-src 'self'`; each token color reaches AA (4.5:1) on the editor's white, with no bold or italic, so the copy lines up with the textarea's text. In high contrast (forced colors) the copy steps aside and the textarea shows its own text.
  - **Notices.** Its license reaches `licenses.md` with the rest of the renderer's (§4.3).

### 4.11 Job progress

Every long step shows its live progress, so the learner always knows where it is and that it isn't stuck.

- **One channel.** Every agent job (§3.2), and a track rebuild, reports on the one-way `codemm:job-progress` event, sent to the app's windows only. The preload exposes it as `onJobProgress`, and `invoke('onJobProgress')` is refused. `jobProgress()` lists the jobs running now, so a screen that opens mid-job gets its progress so far.
- **What a report holds** (`JobProgress` in `shared/api.ts`). It is a whole snapshot, so a later one replaces an earlier one.
  - An opaque id for this run of the job, its kind, the topic for a lesson or author job, and the track's name (never its ref) for a rebuild.
  - The stage reached, an index into `JOB_STAGES` (`shared/progress.ts`).
  - The latest 8 steps, newest first, and a count of all of them. Steps come from the stream parser (§4.9): searches, pages as host and path, and a fixed label per Codemm tool. Searches and pages are shown for research only: another job's agent may still search (Codex has no switch for it), and what it looks up could carry an exercise still being written, which the reply filter doesn't know yet.
  - A retry, after a failed save within the bound in §3.2, or 2 of 2 when a failed job is relaunched. The counts stay in the report, but nothing shows them: a retry reads "Taking a little longer", one line, everywhere.
  - A real fraction within the stage, where one exists: a setup's build steps, or which of the exercise's 3 gates runs.
  - Whether the agent is thinking, which is false while one of Codemm's own tools runs, and the time since the job started and since its last event.
  - The final report says the job ended.
- **Stages.** Each lights up as the job reaches it (`main/agent/progress.ts`):
  - Every job starts on its first stage and moves to the second at the agent's first event.
  - The save tool (`save_roadmap`, `save_lesson`, `save_exercise`) reaches the last stage. A failed save goes back to the second stage and counts as a retry.
  - Setup stays on "Proposing the setup" while its agent runs. A tutor turn has one stage.
- **Setup.** The setup job proposes; a proposal after one failed its gates starts as "Taking a little longer". Once the learner consents, Codemm's own install reports on the same channel: "Building" with core's "Step 3 of 7" (counts only, core §4.4), then "Checking the setup". While Codemm works, the agent isn't thinking.
- **Rebuild.** A track's rebuild (§5) is Codemm's own job, the `rebuild` kind, started by `rebuild(ref)` and ended when it returns, failed or not. It is heard on every screen, whatever course is on screen (the window hears only the jobs of the course on screen, §4.13), and it starts when its turn comes among the builds. Core reports no steps for it, so it has the one stage, "Building and checking", and never a fraction. The report names the track. A track's name is its id as words (`python@1` is Python, `node-js@2` is Node Js), made once in `views.ts` for every screen; Codemm knows no language, so a name the track gives itself is for 1.1. Quitting waits for it as before.
- **Exercise gates.** An author job's server gets `--progress <userData>/progress/<job>.json` (core §8). While `save_exercise` runs, main reads the gate's name from that file every half second and says it in the learner's words: "Codemm is checking that the exercise can be solved", "… that the exercise isn't solved yet" or "… that the tests catch mistakes", as step 1, 2 or 3 of 3. Only a known gate name is read; the file is cleared when a save ends and removed with the job.
- **Safe.** The tracker keeps nothing from a tool's arguments or results, a file or Codemm's records. The reply filter (§2.2) drops a step that shows hidden material, as it does for tutor replies.
- **Emm fills up** (`renderer/ui/JobBar.tsx`, `ui/EmmFill.tsx`). Progress is Emm, grey with its eye closed, filling with color from the tail to the head as the job reaches each stage. Each stage reached fills its share, a real fraction (build steps, gates) fills within it, and the last share is the job done (a one-stage tutor turn is half full). The fill edge breathes while the stage runs. A retry, or 90 seconds of quiet, dims Emm. Under reduced motion there is no breathing and the fill steps. The fill is a second copy of Emm's artwork clipped to the fraction, so it keeps Emm's exact shape. It is decorative; a `progressbar` around it carries the value and a text such as "Checking the exercise, 0:07".
  - **Full** (topic page, Practice until its activity opens, setup, research, the course editor): an 84 px Emm beside the named stages (done in green, the current one in blue, later ones muted) with the time so far, the latest step or "Taking a little longer" beneath, and "Still working: the agent is thinking." after 90 seconds with no event while the agent thinks. Research's heading Emm is its fill. Where no real fraction exists, it shows the stage and the step, never a percentage.
  - **Compact** (the outline, the tutor rail): a 32 px Emm and the latest step (or the stage); where a real fraction exists it reads with the stage ("Checking the exercise 3 of 3"), since a gate's own sentence would wrap to lines. In the outline the time is right-aligned on the label's line. A retry reads "Taking a little longer". In the outline, the lesson or activity keeps its icon and label on the first line, as the other rows do, and the progress line starts under the label.
- **Where it shows.**
  - **Every screen with the sidebar** (`app/WorkNow.tsx`, mounted once in `Sidebar.tsx`): any running job the screen doesn't show itself, under the main navigation. See below.
  - Research: the bar above the live list of searches and pages.
  - The course editor, while "Ask Codemm for changes" or Go deeper runs, or while a roadmap change the learner started and left runs: the editor opened from the sidebar locks its edits and Approve like any change, and reads the draft again when it ends.
  - The topic page and the outline: a lesson or activity being written shows its job's stages (compact in the outline). A job still waiting its turn keeps the quiet shimmer.
  - Practice, until its activity opens: the activity being written shows its job's stages.
  - The topic page and the course map, during setup: proposing, then building and checking.
  - The tutor rail: "Codemm is thinking…" and the turn's latest step.
  - The Tracks page: a rebuild's compact bar on its card, with the time so far. The card's Rebuild is off while it runs, also when the learner left and came back. A card is matched to its job by the track's name, the only name the page shows (it never shows versions). A failure is said on the card (on the banner when the learner has left the page by then): "Couldn't rebuild React." and why, in Codemm's words. This computer's problem says its next step ("Docker isn't running. Open Docker Desktop, then try again."), and a rebuild core didn't accept says "The rebuilt environment wasn't accepted, so nothing changed." (core builds under a candidate tag and keeps the installed image until every check passes). Main makes these (`rebuildFailure` in `notCounted.ts`): core's own messages carry commands, image names and Docker's output and never reach the learner. A damaged record still opens the repair banner.
- **Sidebar.** The learner can leave the page a job started on and still see it.
  - **What it lists.** Research, a roadmap change, setup, a rebuild, and a lesson or activity being written. Not a tutor turn: its answer belongs to its own screen. One job per kind and topic or track, the furthest along (a proposing agent can end its turn while the install runs); if a screen shows a bar for any job of that group, the group is left out.
  - **Each job** is a button: a small Emm filling as in the bars, what it is ("Setting up Java", "Rebuilding React", "Writing a lesson on Variables", "Researching Java"), and beneath it the stage (for example "Building, step 3 of 7"; "Taking a little longer" on a retry; "Still working" after 90 seconds of quiet). It shows no time. A retry or a quiet job dims Emm. In the slim sidebar only Emm shows, named by the same words, which also sit in its tooltip. A job that ends while its button has the keyboard's focus hands the focus to the current navigation item.
  - **Clicking** opens the place the job belongs to: research and its goal, the roadmap's editor (or the course map when it isn't a draft), the current topic for setup, the topic for a lesson or activity, Tracks for a rebuild.
  - **No duplicate.** Every `JobBar` on screen claims its job (`ui/shownJobs.ts`) before paint, and the sidebar leaves out claimed jobs. A screen that shows a job's bar, in whatever form, therefore never also has it in the sidebar, and a new place that shows a bar needs nothing more.
  - It reads the same events as the bars (`useJobs`, which `useJob` takes its newest from) and adds no IPC. Research's reports carry no goal, so the sidebar remembers the goal the research screen last ran for.
- **Mock.** `CODEMM_MOCK=slow-jobs` holds each stage over a few reads, and a rebuild for a few half seconds, so every state can be seen; `quiet-jobs` also shows the quiet line.

### 4.12 Usage and cost

- **Source:** only what the agent CLIs already print. Codemm never calls a model and never reads a credential.
  - Claude Code's `result` line: tokens (input, cache writes, cache reads, output) and `total_cost_usd`, its own estimate.
  - Codex's `turn.completed` usage: tokens, no cost.
  - Cursor's `result` usage, when present: tokens, no cost.
- **Parser:** the stream parsers (`agent/claude.ts`, `codex.ts`, `cursor.ts`) emit `{ type: 'usage', input, output, cachedInput?, costUsd? }`, where `input` counts every input token and `cachedInput` the ones read from cache. Jobs pass each report to `Job.onUsage` with its session.
- **Store:** `usage.json` in userData keeps totals per course and job kind (tokens, cost, runs). It carries `format_version` and is written atomically; a file it can't read starts over, since usage only informs.
  - Only tutor sessions resume, and Claude's cost on a resumed session covers the whole session so far. So the store keeps the highest cost reported per tutor session (a crashed turn can report 0) and adds only the rise.
  - One app process owns userData (§2), as with `desktop.json`, so no second instance writes it at the same moment.
- **Screen:** the course map's side column shows a small Usage card for the approved course once the agent reported a cost: "Estimated cost" and the amount ("under $0.01" below a cent). It's read again whenever the map reads the course. Token counts aren't shown: they're the agent's bookkeeping, not something the learner acts on. The agent isn't named, since agent names stay on the connect screen. Codemm can't tell from the CLI's output whether a run is billed to a plan or an API key, so the card says nothing about billing. Codex and Cursor report tokens only, so with them the card doesn't show; the totals are still kept.

### 4.14 The course map

The map is the course as a path the learner moves along (`renderer/features/progress/`). It is playful in Codemm's own way, not a copy of another app's path: no zig-zag of round buttons, coins, flames or streak counts.

- **Heading.** The course's name (§4.13), with its goal under it in plain text when they differ. A course without a title has the goal as its heading.
- **Emm's branch.** The topics run down one vertical branch in roadmap order, an ordered list named "Topics". Each topic is a leaf on the branch:
  - Mastered: a filled green leaf with a check. Its title opens the topic again, and "Review in 3 days" sits beside it.
  - Now: an outlined green leaf with the code mark.
  - Later: an outlined grey leaf with a lock.
  - The leaf is an image named Mastered, Now or Later, so the state never depends on color alone.
- **Green where the learner has been.** The branch is green between topics the learner has reached (mastered, or the current one) and grey elsewhere. A topic passed over sits on grey: one skipped with "Come back later", or a locked one behind a current topic that jumped ahead.
- **Emm sits at the current topic.** The topic Codemm offers now is a card, marked `aria-current="step"`: a due or in-progress review, otherwise the Now topic. Emm, in the track's color, sits on the card's top edge, facing the topic. Emm thinks when the topic is stuck and looks at a review. Emm is decorative; the card says everything in words.
  - **Now:** the title, a bar with one step per lesson and one for the activity, "Lessons 1 of 3" (a check and "Lessons" once all are read), and Continue. Once the activity is open, the card also says which activity this is: "Activity 2" (§4.15), never "of N" or how many are left.
  - **Review due:** the title and Review.
  - **Review being written:** "Writing the review", replaced by its job's compact progress once the job runs (§4.11), and nothing to press.
- **Easier and skip** change the path, not the map's controls. "Try an easier one" adds a topic before the stuck one, which becomes the one to do now. "Come back later" moves Now to the next topic ready. Both stay on the results screen (§3.2).
- **Setup.** While the track sets up (proposing, then building and checking), a "Setting up React" card above the path shows the setup job's progress (§4.11). Until the job's first report arrives, one quiet line says "Preparing setup for React" or "Setting up React". The path stays usable, since lessons can be read during setup. Consent, a failed setup and its retry stay on the topic page.
- **Side column.** "Mastery" counts the topics mastered ("2 of 8 topics") above a bar per topic started, then the Usage card (§4.12). A bar starts empty: before a topic's first check its mastery is only core's starting estimate (0.5), so the course view reports 0 until then.
- **Finished.** A finished course opens on the completed-course screen. View course shows the path with every leaf mastered, nothing to continue, and Emm cheering where the branch ends.
- **Motion.** The path fills and lands in order: each topic's part of the branch draws, its leaf pops on, its title rises, then the current card rises and Emm lands on it with a small squash. Topics after the eighth land together, so a long course takes no longer. Under reduced motion nothing moves.
- **Narrow windows.** Under 1000 px the side column goes under the path. In narrow rows, a review date wraps under its topic and the card's button under its title.

### 4.15 A topic's activities (1.1)

A topic has a series of activities, one after another, until it is mastered (core §7). The app shows where the learner is in it and lets them go back or ask for more.

- **Numbers.** An activity's number is its place among the topic's saved activities, oldest first, counting from 1. An exercise on two concepts has a number in each topic. Numbers come from `listExercises`, never from the exercise's id, which stays hidden.
- **Activity N.** The course map's card (§4.14), the topic page and the activity screen name the activity on offer as "Activity 2". A review keeps its "Review" label instead. There is never an "of N", a count left or a streak.
- **Past activities.** The topic page lists the topic's activities the learner has checked, and the one on offer, oldest first, as "Activity 1", "Activity 2", with a check on each passed one. An activity written ahead and not on offer yet isn't listed. Choosing one opens it on the activity screen with the learner's files as they left them; an activity not of that topic is refused. Checking a passed one again is a repeat pass, which changes nothing (core §7); checking one not passed yet is an ordinary check.
- **Stuck.** With no `practice` or `review` step for the topic, its activity is the one the learner checked last (the latest saved, when none is checked), so the ways forward (§3.2) sit under the results the learner got, not under an activity written ahead.
- **More practice.** The topic page of a mastered topic, or of the current topic once its activity is open, shows More practice. A later topic shows none, and main refuses it. More practice calls `morePractice(concept)`, which asks core's `next_step` for `more`:
  - `practice`: Practice opens that activity.
  - `author`: main starts a More practice author job (§3.2) and Practice waits with its progress ("Practice opens here once your activity is written."), asking again until an activity comes back, then opens it.
  It writes at most one activity per request, and none when the topic has an activity at that difficulty the learner hasn't tried. Its checks are recorded like any other (core §7).

### 4.13 Several courses

A learner can keep several courses and switch between them in one Codemm. With one course, nothing changes.

- **Courses.** Approving a roadmap adds its course to the learner's courses (`courses` in `desktop.json`, oldest first) and puts it on screen (`approved`). A roadmap not approved yet is still the draft (§4.2). Core already keeps several courses, each behind its own lock.
- **Names.** Until research saves a roadmap, the goal screen's notice, the research heading and the job's row name the typed goal tidily (`shownTopic`): spaces collapsed, a trailing "?" or "!" dropped, the first letter capitalized unless the second already is ("iOS"). The notice matches that tidied goal against the tracks' names, so "react?" with React set up says nothing. A course is named by the `title` the agent gave its roadmap (core §5), and the agent's goal shows beneath the name where they differ. A roadmap without a title is named by its goal, so a new course never shows the raw words typed. A course researched before titles keeps the words typed for it then (`names` in `desktop.json`), even once a change adds a title. The mock names a course as an agent would, by the tidied goal. Edits and saved sources keep the title.
- **Coming back.** Opening Codemm with a course on screen and the agent connected goes straight to its course map.
- **Switching.** The sidebar lists the courses, with the one on screen marked, and **New course**, which opens the goal screen. In the slim sidebar each course is its badge (its name's first character as the eye sees it, so a flag or a joined emoji stays whole, capitalized when that stays one letter), with its name as the label. Choosing a course puts it on screen and opens its course map. Learner reads and calls bind to it, as before, except that the editor's last save goes to the course its activity was opened in. Switching keeps every course's records; the renderer drops the lessons and conversations it cached.
- **What keeps running.** Each course has its own lanes, as one course had (§3.2): one foreground job and one background queue. A course's jobs run to their end after a switch, and the work they make due next for that course follows, up to its current topic's lesson and activity. A setup install keeps building. Setup belongs to the track, so courses on one track share one proposal and one install, see its progress, stall together if it fails, and move on together when it ends. Two courses with the same name are told apart by their goals in the sidebar. At start, only the course on screen starts work; another starts when the learner opens it.
- **Docker-heavy work takes turns.** Across courses, one track build runs at a time (a setup install or a rebuild), and one author job, whose save builds and checks the exercise in containers. The next waits its turn, shown as waiting. Check, Try it and Run are the learner's own and never wait (Run stays at 4 programs).
- **Stalls are per course** (§5). A failed background job stops only its course's background work, and each course shows its own stall; Try again restarts only that course. Some stalls end by themselves, and the course's work starts again:
  - A stall because Docker stopped, is busy or is failing ends once Check this computer passes.
  - Those, and a stall because a disk is full or the track's image needs a rebuild, end once a check, Try it or setup install of that course succeeds.
  - Signing in again restarts every course that stalled on a sign-out.
  - An agent Codemm couldn't stop still stops every job (§3.1).
- **Job progress** (§4.11) reaches the window for the course on screen, research and the draft. Another course's jobs report again once it is on screen.
- **The tutor.** Each course keeps its own tutor session (`sessions`, keyed by course and agent) and its own queue of turns. A question in one course never waits for another's turn, and coming back to a course resumes its conversation.

## 5. Failure states

Infrastructure failures record nothing. Learner-caused outcomes are graded as `error` and recorded (core §4.3, §7).

| What happened | What the learner sees | Recorded |
|---|---|---|
| Docker missing, not running, still starting, or stopped mid-session | "This check wasn't counted." ("Try it didn't run." for Try it) and Check this computer (§6.1), with why: "Docker isn't running.", "Docker is busy or not answering.", "Docker couldn't run that.", "Docker ran out of disk space." or "This computer is out of disk space.", or a reason core named, with what to change (Docker has fewer than 2 CPUs, its logging driver, its file sharing) | nothing |
| Offline or low disk during setup | "You're offline." or "Not enough disk space.", then Try again (§6.1) | nothing; no agent runs |
| Docker Desktop doesn't run on this macOS or Windows | before anything downloads, "Docker Desktop needs macOS 14 or later. Update macOS to install it." or "Docker Desktop needs Windows 10 22H2, or Windows 11 23H2 or later. Docker no longer supports older versions, so update Windows first." with **Open Windows Update**, or "Docker Desktop doesn't run on Windows Server." (§6.1) | nothing |
| Offline while installing Docker or an agent, including a download with no bytes for 60 seconds or one that loses the network midway | "You're offline. Connect to the internet, then try again.", with Try again (§3.1, §6.1) | nothing |
| The learner says no to Windows' permission prompt for Docker's installer | "Windows asks for permission to install Docker. Try again, and choose Yes.", with Try again (§6.1) | nothing |
| Track image missing or changed | "This environment needs a rebuild." with Go to Tracks; "Rebuild" on the track runs `rebuildTrack` with its progress on the card (§4.11), then says "Rebuilt."; a failure says "Couldn't rebuild React." and why. An agent job that finds it so stalls with the same words, Go to Tracks and Try again, never Check your agent | nothing; no relaunch |
| No agent found, or signed out | the connect screen with its fix | nothing |
| Agent plan limit reached | "Your agent's plan limit is reached. Try again later." | nothing; no relaunch |
| Offline during an agent job (the agent can't reach its service, or a Codemm tool can't reach the network) | "You're offline. Connect to the internet, then try again." Try again | nothing; no relaunch |
| Docker stopped, busy or failing, or the disk full, during setup or an agent job (core or a Codemm tool says so) | Stopped (missing, not running, unreachable): "Docker stopped. Start Docker, then try again." with Check this computer and Try again. Busy (no answer even when asked again for longer, a check past the host's deadline, a container removal that didn't finish, an ended attempt's containers it didn't remove; Codemm doesn't wait on a busy Docker to clean up after a job): "Docker is busy or not answering. Wait a moment, then try again." with Try again. Answering but failing (a container that couldn't start, a run the runtime failed, its credential helper, Windows containers, or a failed list of its containers): "Docker couldn't run that. Try again, and restart Docker if it happens again." with Check this computer and Try again. Docker's disk: "Docker ran out of disk space. Remove unused images in Docker Desktop, then try again." This computer's disk: "Not enough disk space. Free some space on this computer, then try again." Each with Try again; a failed setup also offers Stop. Never Check your agent | nothing; no relaunch |
| Another agent failure (model refused, crash, deadline) or not done by its check | "Codemm couldn't finish writing a lesson." (or "writing an activity", "setting up the course": the stalled job's kind) Try again, or Check your agent (opens connect). A lesson job's failure keeps the lesson's row instead, saying "Codemm couldn't write this lesson." with Try again, and blames no agent | nothing; saves are atomic |
| Track gates fail | "Couldn't set up React." A new proposal asks again; after the bound, Stop or Try again | nothing |
| Author bound reached | "Couldn't write this activity." Try again | nothing |
| Editor file changed outside Codemm | the editor reloads it | nothing |
| A course is busy (lock) | a working state; core waits up to 10 minutes | nothing |
| Corrupt event log | "Codemm's records need a repair." with the doctor result | nothing |
| App quits or cancels during a job | agent process groups are killed, then leftover containers are cleaned up | nothing |
| Build error, timeout or output flood in learner code | the test results, as errors | a `check` event |

**What a failure says.** Codemm's words for a known problem (the table above, `SAY` in `renderer/app/errors.ts`). For any other failure, the banner and the rebuild card show main's own message, its first line only, and only if it is a plain sentence: whole, with no path, command or tool name, since core's messages for agents carry those. Anything else, and any error the window itself made (a `TypeError` and its kin), says "That didn't work. Try again." Main lets only learner-safe messages cross (`main/errors.ts`), so a call such as Run or Check that fails for a reason Codemm knows, for example "Too many programs are running. Stop one, then try again.", says so.

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
| Docker is installed | the `docker` CLI is found (§3.1 lookup). On macOS and Windows, a `docker` command without Docker Desktop's app (Homebrew's, or a stopped Colima or OrbStack) passes only while its engine answers: with the engine down, Open Docker Desktop would fail, so this row offers Install Docker. Docker Desktop's app is `/Applications/Docker.app` or `~/Applications/Docker.app`, or `Docker Desktop.exe` in `%ProgramFiles%\Docker\Docker` (all users) or `%LOCALAPPDATA%\Programs\DockerDesktop` (one user). | On macOS and Windows: **Install Docker**, which Codemm does for the learner (below), plus "Install it myself", linking to Docker's install page. On Linux: Docker Engine's install steps and link. |
| Docker is running | the daemon answers with Linux containers | `docker info` gets 20 s, and an engine that gives no answer, or answers that it isn't ready, is asked once more for 60 s (core `runtimeState`), since a busy one can be slow. A Docker that refuses, or still doesn't answer, is stopped: "Open Docker Desktop, then wait until it says it is running.", with an **Open Docker Desktop** button on macOS and Windows (it opens whichever Docker Desktop is installed, for all users or for this one). It is "Docker is starting. This can take a few minutes." only for 3 minutes, since Codemm can't otherwise tell a stopped daemon from a starting one. The 3 minutes start when Codemm itself opened or installed Docker, or when this screen first saw Docker Desktop's app running with its engine down, as when the learner opened it (`pgrep -f /Applications/Docker.app/`, which matches `~/Applications` too, or `tasklist` for `Docker Desktop.exe`). A Docker Desktop on Windows containers gets "Switch Docker Desktop to Linux containers." On Windows, what WSL needs comes first, since Docker's engine can't start without it (below, "WSL on Windows"). |
| The sandbox works | doctor's network check passes | "Codemm couldn't confirm the sandbox. Restart Docker and check again." In the 3 minutes after Docker came up (after this screen saw it missing or stopped, or after Codemm opened or installed it), a failure says "Docker just started." and "Still checking. This can take a minute after Docker starts." instead, since a fresh Docker's first container can fail on its own. Each failure's reason goes to the app log (§5). When core's self-test knows the cause on this computer (its `kind`: offline, disk or docker, core §4.3), the row shows the self-test's own words instead of "Restart Docker". Those words say what to do: connect to the internet (or, for Docker Hub's limit or an intercepting proxy, what that means), free disk space, share the folder Codemm's checks mount, or fix Docker's sign-in helper. The line under the rows says "You're offline." or "Docker ran out of disk space." for those kinds. Offline and disk show at once, even in Docker's first 3 minutes, since they aren't a slow first container. An inconclusive result shows what it saw, followed by "Restart Docker, then check again." With no kind, the row says only "Restart Docker". |

- **Moving on.** On the way in from Connect, when every row passes at the first check, the screen moves on by itself, so a first run goes from Connect straight to the goal: three clicks from the welcome screen. An explicit Check this computer (after a setup or a check failed) says "This computer is ready." and waits for Continue, as it does after a step. On the connect screen, the only supported agent installed is checked for sign-in at once, so it shows connected without a click. That happens once, on the first look that finds a supported agent (one installed in a terminal while the screen is open counts), and never while another agent is connected.
- **Re-checking.** Only the first failing row shows its message. Only one check runs at a time: the next starts 5 seconds after the last finishes, or at once when the window regains focus and no check is running. Re-checking stops once every row passes, and Continue unlocks.
- **Docker stopping mid-session.** A check or setup that loses Docker fails as an infrastructure failure, records nothing, and opens this screen.
- **Docker's slow first start.** Setup and checks started while Docker is starting (in those 3 minutes) wait for the daemon before failing, and record nothing. With a stopped Docker they fail at once as not counted.
- **Launch.** While Codemm looks for the agents, Welcome shows "Codemm is starting" beside Emm asleep, so the first seconds are never a blank window.
- **Install what's missing** (`features/setup/Setup.tsx`). On a first run with Docker not installed, or no agent installed, Welcome's one primary action is **Install what's missing**.
  - Its screen lists what will be installed (Docker Desktop says "Not installed"), with each maker's terms and the agent to install (Claude Code by default, or Codex). Cursor isn't offered here while it's experimental: it installs from its Connect row, which says so. The terms line names no price. Nothing downloads until the learner clicks Install what's missing.
  - It then runs the Docker install and the agent install side by side, each showing its progress and result. If Docker's 3 minutes to start end with Docker still stopped, Docker's card shows Check this computer's step instead, with Open Docker Desktop and Check now.
  - The learner then sees Docker's terms window, then the agent's sign-in (enabled once Docker's install has handed over to Docker), in that order.
  - Once Docker is ready and the agent is connected, Codemm moves on to the goal.
  - Install Docker (below), each agent's Install and Get it myself, and "Do it myself" stay for doing it one at a time.
- **Installing Docker Desktop for the learner** (`desktop/src/main/dockerDesktop.ts`). One click on Install Docker, on macOS and Windows:
  1. Before anything downloads, Codemm checks that Docker Desktop runs on this computer, against Docker's documented minimums (release notes 4.48 and 4.49):
     - macOS: `sw_vers -productVersion` is 14 or later;
     - Windows: `reg query` of the `CurrentVersion` key gives build 19045 (Windows 10 22H2) or 22631 (Windows 11 23H2) or later, but not Windows 11 before 23H2, and an installation type that isn't Server. Windows Home runs Docker's Linux containers, which is all Codemm needs.
     Otherwise it says what Docker needs ("Docker Desktop needs macOS 14 or later. Update macOS to install it."). An answer it can't read lets Docker's own installer decide.
     - An older Windows gets **Open Windows Update**, which starts `C:\Windows\explorer.exe ms-settings:windowsupdate` as an argument array, with no shell. Windows Server gets no step: Docker Desktop never runs there.
     - No older Docker Desktop is offered. Docker supports Docker Desktop only on Windows versions still in Microsoft's servicing ([its install page](https://docs.docker.com/desktop/setup/install/windows-install/)), which Windows 11 22H2 left in October 2024 (Home and Pro) and October 2025 (Enterprise and Education); release 4.49 ended its support. An older release would still install, but without Docker's later security fixes, so updating Windows is the way.
  2. Codemm checks there is room (4 GB on macOS, 8 GB on Windows), then downloads Docker Desktop for this computer's own chip (§3.1) from `desktop.docker.com` over https, through Electron's network stack. A redirect may only land on another https docker.com host.
  3. It runs the download only if Docker signed it:
     - macOS: `codesign --verify --deep --strict`, Docker's team id `9BNSXJN65R`, and `spctl --assess`;
     - Windows: `Get-AuthenticodeSignature` reports Valid, signed by `O=Docker Inc`. The path reaches PowerShell as an environment variable, never inside the command text.
     Otherwise it deletes the download and says so.
  4. macOS: a Docker.app already in /Applications or ~/Applications opens instead, with nothing downloaded. Otherwise Docker.app is copied with `ditto` into a staging folder in /Applications, moved in place and opened. If the copy isn't allowed, the disk image opens in Finder for the learner to drag.
     Windows: first WSL's own setup, when WSL needs it (below), so Windows' one permission prompt comes while the learner who clicked is there. Then Docker's own per-user install, Docker's default since 4.83.0 (its release notes, 2026-07-20): `"Docker Desktop Installer.exe" install --user --quiet --backend=wsl-2`, run directly, not as administrator. Its manifest asks for no administrator (`asInvoker`, checked on every run of the install matrix, `.github/workflows/agent-installs.yml`), so there's no permission prompt and no error 740 for a standard user, and `--quiet` hides the installer's window and its install-type page. It installs in `%LOCALAPPDATA%\Programs\DockerDesktop`, with the CLI in its `resources\bin`, which Docker adds to the learner's own PATH (§3.1 looks there). Per-user Docker Desktop doesn't run Windows containers, which Codemm doesn't use.
     - If Windows says the installer needs an administrator after all (error 740, from a later installer's manifest, which Codemm can't see before it downloads), Codemm runs Docker's all-users install once as administrator, through the same .NET `runas` script as WSL's setup (below): `install --quiet --backend=wsl-2`, since a per-user install as administrator would go to that administrator's account. The screen says "Allow Docker's installer when Windows asks (look in the taskbar)."; a learner who says no sees "Windows asks for permission first. Try again, and choose Yes."
     - Nothing downloads, and no download folder is made, when a Docker Desktop is already here.
     - A Docker Desktop already here, for all users or for this one, is never installed over: Codemm sets up WSL if it needs it and opens that one. Since Docker 4.90.0 (its release notes, 2026-09-07), an all-users install offers its own move to per-user, which is the learner's choice in Docker's window.
     - Exit codes: 0 is installed; 3010 and 1641 mean Windows needs a restart; any other code, such as Docker's unattended 1 or 1603, is "Docker's installer didn't finish."
     - The screen says "Installing Docker…".
     Leftovers: a Codemm that quits midway can leave a staging folder behind, and a Mac install the learner finishes by hand keeps its download. At start Codemm removes its own over an hour old: staging folders (`.codemm-docker-` and 8 hex digits, with `/bin/rm -rf` so a 2 GB copy doesn't hold up the app) and download folders in the temp folder (`codemm-docker-` and 6 characters). A younger one may be another Codemm's install.
  5. Codemm never accepts Docker's terms or types a password: Docker's own window and Windows' permission prompt do that, and the screen says so. So Codemm never passes `--accept-license`: the vendor's terms appear in the vendor's own window, and Docker's Accept stays in Docker Desktop's first window. It's one click either way.
  6. The screen shows the download's progress, then each step, said once: the row's title and Emm's fill with its text, with no state word beside it and no footer line under it. A stop says why: this macOS or Windows can't run Docker Desktop, offline (no network, or none for 60 seconds), low disk, not signed by Docker, the learner said no to Windows' permission prompt for WSL, WSL's setup didn't finish, Windows needs a restart (with **Restart now**), or the installer didn't finish. Every command is an argument array, the system's own tools by absolute path so none earlier on PATH stands in (macOS: `codesign`, `spctl`, `hdiutil`, `ditto`, `mv`, `open`, `rm`, `sw_vers`, `pgrep`; Windows: PowerShell, `reg`, `tasklist`, `explorer`, `wsl`, `shutdown`), and the download is deleted afterwards.
- **WSL on Windows** (`desktop/src/main/wsl.ts`). Docker Desktop runs its engine in WSL 2, which needs WSL 2.1.5 or later, Windows' Virtual Machine Platform, and virtualization on in the PC's firmware.
  - **Reading it.** Before Docker's install, and on every check while Docker's engine doesn't answer:
    - PowerShell reads `Win32_Processor.VirtualizationFirmwareEnabled`, `Win32_ComputerSystem.HypervisorPresent` and the `VirtualMachinePlatform` feature's `InstallState` (`Win32_OptionalFeature`), once per run of Codemm, since none changes while Windows runs, within 15 seconds. A failed answer is read again on the next check; one that timed out isn't. A running hypervisor makes the firmware flag read false, so a hypervisor counts as fine. Windows' own security features can run a hypervisor without the Virtual Machine Platform, so the feature is read too.
    - WSL counts as installed when `%ProgramFiles%\WSL\wsl.exe` is there (WSL 2.0 and later). Only then does `C:\Windows\System32\wsl.exe --version` run, with `WSL_UTF8=1` (wsl.exe writes UTF-16 otherwise): Windows' own wsl.exe without WSL can offer to install it at a keypress. The version is the first number it prints, in any language. `wsl --status` isn't read: it prints only localized prose.
    - What it needs, in order:
      1. virtualization, when the firmware has it off and no hypervisor runs;
      2. set up, when the Virtual Machine Platform is off (where the feature can't be read: no hypervisor runs). Setup comes before the update, which doesn't turn the Virtual Machine Platform on;
      3. a restart, when the Virtual Machine Platform is on but no hypervisor runs and Windows' servicing stack says a restart is pending (`reg query` of `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`), as when Codemm was reopened before it. With none pending, it's a hypervisor turned off on purpose, which claims nothing rather than loop the learner through restarts;
      4. set up, when WSL 2.0's package isn't installed; an update instead when the Virtual Machine Platform is on, since that's an older WSL (Windows' own, or the Store's 1.x) its update replaces. Unconfirmed: whether Windows 10 22H2's own wsl.exe takes `--install --no-distribution`;
      5. an update, below 2.1.5.
    - WSL read ready stays ready while Codemm runs, so the checks while Docker starts run nothing. An answer it can't read claims nothing, and Docker's own state shows.
  - **Docker is running** says the real cause instead of "Docker is starting" or Open Docker Desktop:
    - "Docker needs WSL, Windows' own Linux support. Set it up, then restart Windows.", with **Set up WSL** and Microsoft's steps;
    - "Docker needs a newer WSL. Update it, then check again.", with **Update WSL**;
    - "Turn on virtualization in this PC's BIOS or UEFI settings, then start Windows again. Your PC maker's site shows how.", with Microsoft's page on it. That step stays the learner's;
    - after WSL's setup, or when Docker's installer asked for a restart, "Restart Windows to finish setting up Docker. Save your work in other apps first.", with **Restart now**. Codemm remembers it until it quits: reopened before the restart, it reads WSL again.
    - A stop of Docker's own install (not signed, offline) stays on the installed row: this row shows only WSL's.
  - **Setting it up.** Install Docker on Windows, and Set up WSL or Update WSL, run WSL's own setup when it's needed: `wsl.exe --install --no-distribution` (WSL and the Virtual Machine Platform, no Linux distribution) or `wsl.exe --update`, as administrator, through the same .NET `Process.Start` and `runas` verb as before, the program and its arguments as environment variables. `Start-Process` isn't used: it drops Windows' code for "the learner said no" (1223), and its `-Wait` waits for every process the setup leaves running. After `--install`, Windows needs a restart unless the Virtual Machine Platform was on and running already (only WSL itself was missing); after `--update`, it doesn't; 3010 or 1641 always means a restart. One permission prompt; just before it the screen says "Allow WSL, which Docker needs, when Windows asks (look in the taskbar).", since the prompt can open behind Codemm, and never when WSL needs nothing. A learner who says no sees "Windows asks for permission first. Try again, and choose Yes." Docker's install follows at once, without waiting for the restart.
  - **Restart now** (`windows.ts`) runs `C:\Windows\System32\shutdown.exe /r /t 0`, only on the learner's click, with no console window. With no wait, `/f` isn't implied, so other apps can still ask to save. If Windows refuses (a policy), the learner is told to restart from the Start menu. Codemm doesn't reopen itself after the restart (§12).
  - Nothing elevated, and no restart, ever runs without the learner's click.
- **Offline or low disk during setup.** These count as infrastructure failures: nothing is recorded and no agent attempt is spent.
  - **Disk.** Before building, `installProposal` checks that the volume holding `$CODEMM_HOME` has at least 5 GB free, failing with "Not enough disk space".
  - **Build output.** A failed build whose output matches a known marker is an infrastructure failure (core §4.4): disk full ("no space left on device"), Docker's credential helper ("error getting credentials"), or the network: a name or route that fails ("could not resolve host", "network is unreachable", "proxyconnect"), Docker Hub's pull rate limit ("toomanyrequests"), an intercepted certificate ("certificate signed by unknown authority", "unable to get local issuer certificate"), or a connection that timed out or dropped ("i/o timeout", "TLS handshake timeout", "net/http: request canceled", a download's "unexpected EOF"). Any other failed build is a gate failure.
  - **Try again** re-installs the same proposal (§4.1).
  - **How the desktop tells.** Core's errors carry a `kind` (no-course, image-missing, damaged, changed, docker, disk, offline; core `src/errors.ts`), and this computer's problems also a stable code (core §8, "Failure codes"). The desktop acts on them, never on the wording (`core/failures.ts`): the code says whether Docker stopped, is busy, or answers but failed, and whose disk is full. A native out-of-space error (`ENOSPC`) is this computer's disk; a kind without a code reads as stopped Docker, the disk or the network. What an agent relays over MCP carries no error object, so the desktop reads only the code on the first line of a Codemm tool's failed result (`codemm:<code>`; an agent's own words may come before it there), and nothing from the agent's other tools. It never reads the rest, which can quote a build log, a track's runner or a lesson example's output.
  - **The app log** records each ended job, each failed setup, each run that wasn't counted and each failed call with the problem and core's code as `cause`, never core's text, which can carry track output: `job-end kind=setup ok=false problem=docker-busy cause=runtime-busy ms=…`, `setup-failed problem=docker cause=runtime-down`, `not-counted run=try reason=… cause=check-timeout`. `cause=other` is a kind without a code.
- **Agent problems.**
  - No agent found and signed out go to the connect screen.
  - A plan limit is recognized from the agent's `done` error, by known per-agent limit markers ("usage limit", "rate limit", HTTP 429). A plan limit is never relaunched and spends no retry. An unrecognized error is a generic failure.
  - Offline is recognized the same way, from network errors in the agent's `done` error ("Connection error", ENOTFOUND, EAI_AGAIN, "network is unreachable", "could not resolve host", "error sending request", "connection lost"), or from core's offline markers in a failed tool result. It is never relaunched, spends no retry, and never offers Check your agent.
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

**Decision (O9).** Beta builds stay unsigned. The public 1.0 is signed (D21): the macOS build is signed and notarized, and the Windows installer is signed. Auto-update installs updates only in signed builds (§7.2).

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

### 7.2 Auto-update

- **Where:** electron-updater 6.8.10 (MIT) on GitHub Releases. `packaging.cjs` sets `publish` to this repository, so each build carries an `app-update.yml`; the build itself never publishes (`--publish never`).
- **When:** at start and every 6 hours, in an installed app only. A prerelease build sees prereleases; a stable build sees stable releases only (`allowPrerelease` follows the running version). Prereleases ship only as `alpha` or `beta` (`releaseTag` refuses others): electron-updater moves those channels on to the next stable release, but not a custom one such as `rc`.
- **Notice:** one `role="status"` region at the foot of the sidebar, so a screen reader hears the news without a focus move. The renderer reads the status on each screen and every 30 seconds until there is something to show.
- **Signed builds** download a new version in the background. It's ready only once the platform has checked it: on macOS, when Squirrel.Mac has fetched it and checked its signature (Electron's own `update-downloaded`, not electron-updater's earlier one). A failed check goes back to quiet. Then the sidebar says "A new version is ready." and offers **Restart to update**. It first stops Codemm's agent jobs and removes its containers, the same shutdown quitting waits for, and only then starts the installer, which may end the app at once.
- **Unsigned builds** can't install one (macOS refuses an unsigned update), so they never download. The sidebar says "A new version is available." with a link, **Get it**, to that release's page, which opens in the browser. The version is in the link, never in the words. A version goes into the link only if it looks like a release tag.
- **Signed or not** is decided at build time: `packaging.cjs` records `codemm.signed` in the packaged `package.json`, from that platform's own signing settings. A build that says it's signed must be: `forceCodeSigning` makes it fail rather than ship unsigned when no signing identity is found.
- **Installing only what's signed.** On macOS, Squirrel.Mac checks the downloaded app's signature against the running app's designated requirement before it installs. On Windows, Codemm replaces electron-updater's signature check, which lets an update through when PowerShell can't run, with one that fails closed. It needs a valid Authenticode signature from the publisher the build names, and refuses the update on any error. The signer's name is read only when it's plain: one with characters outside printable ASCII, quotes, backslashes or multi-valued parts is refused rather than matched on a guess at Windows' quoting (Codemm's own certificate has a plain name; anyone else's update would be installed by hand). Windows PowerShell runs by its full path (`main/windows.ts`), never by name, and the file reaches it through the environment, never inside the command.
- **Release workflow:** it attaches the `latest*.yml` feeds (and any channel feeds, such as `beta-mac.yml`), the Mac zips that Squirrel.Mac updates from, and the blockmaps, beside the installers. The release stays a draft until the owner publishes it, so no app sees it before then.
- **Failures** (offline, no release yet, a bad feed) are logged as `update-error` and change nothing on screen.
- **Tests:** `updates.ts` has its decisions covered with a fake updater. An e2e test points the development app at a local feed (`CODEMM_UPDATE_FEED`, honored only when not packaged) and checks that electron-updater finds the newer version and an unsigned build only links to it.

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
| D3 | **IPC contract.** Every IPC channel is declared in `shared/api.ts`. Each handler validates its input and calls one function. Unknown channels and bad input are rejected. Text fields take no more than main accepts (`shared/limits.ts`: goal 200, what you know 500, topic name 200, a request or question 2,000, a note 20,000 characters) and say "Up to N characters." once full, so ordinary typing never reaches "Bad input". |
| D4 | **Learner-safe boundary.** An exercise whose solution, mutants, hidden tests and expected outputs hold canary strings is authored through a recorded author stream. Every IPC handler is driven, and no renderer-bound payload or app log holds a canary. A tutor reply that quotes a canary line is held back. |
| D5 | **Agent bridge.** For Claude Code and Codex: launch arguments match §3.1, and recorded streams parse to the expected events, while malformed lines produce none. A cancelled job resolves only after its whole process group is gone, including a child that ignores SIGTERM, and a job cancelled before it starts never spawns. Overlong lines are dropped. Status commands stop at their deadline and cap. There is no stdin and no shell. No desktop code reads credential files or variables, and sign-in output (for example, an email address) never reaches IPC or logs. |
| D6 | **Versions and the minimum model.** Each tested version's `--version` output parses to its full token. An untested version (another major, older than the oldest tested, or a prerelease) shows the warning and doesn't block; a later release of a tested major doesn't. A connected agent offers only its bench-tested models, with the recommended one preselected. The choice is saved in `desktop.json`, and every job for that agent launches with it (`--model` or `-m`). A model that isn't on the list is refused. |
| D7 | **One consent.** With `--desktop`, `save_track` stores a proposal and builds nothing. Only `installProposal` builds, and only when the digest matches; a proposal whose files changed after the learner saw them is refused. Approving a roadmap never builds. |
| D8 | **Roadmap.** `get_roadmap` round-trips. Rename, add, move and remove keep ids. A move is refused when a topic would come before one it requires, and a remove is refused for a required topic or one used by an exercise, event or lesson. An uninstalled track gives `setup`. The track can change until the course has exercises, and the change cancels the old track's jobs and proposals. Adding a prerequisite to a stuck concept records `retry`. |
| D9 | **Lessons.** Save, get and notes work, and writes are locked, atomic and versioned. `get_lesson` records nothing; only `mark_lesson_read` records a read. The `lesson` field on `practice` and `author` steps is `null`, the earliest unread id, or absent, as §4.3 says. Reopening a saved lesson or activity starts no agent process. A lesson's `mermaid` fences are drawn as images (flowchart, chart, sequence, state and class kinds), a broken one shows its source with a note, labels with markup draw as text, and a lesson without a diagram loads none of the library (renderer tests). |
| D10 | **Skip.** Skip defers without changing mastery and never satisfies a prerequisite. With every candidate deferred, the earliest is chosen. `done` needs every concept mastered. After `retry`, a concept that was stuck isn't stuck, and its mastery is unchanged. |
| D11 | **Activity.** A save with a stale digest is refused, and one through a symlinked path is refused. Run and Try it record nothing. Check of edited files that completes grading records one attempt; core §7's exceptions hold, so a check of unchanged starter files or an infrastructure failure records nothing. Continue after a pass that doesn't master the topic opens its next activity on Practice, and one after which a review is offered opens the review there; Practice waits with its progress while the activity is written and then opens it by itself (renderer tests). Tutor turns launch with no edit tools. |
| D12 | **Jobs.** `codemm mcp --tools a,b` lists and accepts only `a` and `b`, and `--course` scopes course tools. Switching courses during an author job doesn't redirect its save. Done checks read records created after the job started, and a job whose save committed before a crash isn't relaunched. An author job is cancelled after 3 failed saves. Every job stops at its deadline, and a failed job is relaunched at most once. Cancelling during a check leaves no owned container behind. |
| D13 | **Check this computer and the environment matrix.** With the fake Docker and fake agent, each case shows its message and records nothing: missing Docker; not running; still starting (the starting message for 3 minutes after Codemm opened Docker, then the fix); installing Docker for the learner, including a download not signed by Docker; Windows containers; stopping mid-check; offline during setup; low disk during setup; no agent; signed out; plan limit. Offline, low disk and plan limit spend no agent retry. For the Docker cases, fixing the fake makes the screen pass on its own within one re-check, and repeated focus events never start a second check. The setup cases recover through Try again on the same proposal, and the agent cases through the connect screen. |
| D14 | **Failure states.** Each row in §5 maps to a tested screen state. |
| D15 | **UI rules and no language dispatch.** Rendering every screen shows agent names only on the connect screen, the tutor named "Codemm", and no ids, versions, paths or timestamps. Core A1's scan covers `desktop/`, and track names and colors come from `list_tracks` or the learner. |
| D16 | **Accessibility (WCAG AA).** Every journey screen passes an automated accessibility check with no AA violations, and every control has a screen-reader name. The D17 flow completes with the keyboard alone. With reduced motion set, nothing animates. Every screen reflows down to 320 CSS pixels (400% zoom) and in the smallest window, 800 by 600: nothing but code sticks out past the window, the course map's side column goes under the topics below 1000 px, and the sidebar slims below 760 px (its logo is then Emm, since the wordmark's "<" alone would read as a Back button). |
| D17 | *Journey*, on macOS with Docker Desktop, in the packaged app, for Claude Code and Codex: connect, Check this computer, goal, roadmap edit, approve, setup consent, lesson with a note, a failing check, a passing check, skip, and the course view. |
| D18 | *Journey*, on the owner's Windows PC, from the downloaded installer: a whole small course, from connect to course complete. |
| D19 | *Journey*, Cursor: attempted. If it can't be signed in and run, its connect row says it is experimental. |
| D20 | *Release*: the beta exit criteria in [beta-plan.md](beta-plan.md) pass before the public 1.0. |
| D21 | *Release*: the public 1.0 is signed. The macOS build passes notarization (`spctl -a -vv` accepts it), and the Windows installer passes `signtool verify /pa`. |
| D22 | **Several courses.** With two approved courses, switching binds learner calls to the course on screen and keeps the other's records. A stall in one course never stops the other's work. The other course's running job finishes after a switch. Builds and author jobs take turns across courses. Each course resumes its own tutor session. A Docker stall ends once Check this computer passes, or once a check of that course succeeds. |

### 1.1 acceptance criteria

Core's B1 to B5 are in core §2. Each item here is verified by an automated test, with a fake core or the mock where it says so, and fake agents.

| # | Requirement |
|---|---|
| B6 | **Author targets come from core.** An author job's brief carries only a request core understands (none, `ahead`, or `more` with a topic), never a concept or difficulty of the app's own. When its turn comes, an author job launches only if core still names its target (§3.2); otherwise no agent starts and its course doesn't stall. Test: an author job queued behind another, whose target the learner's check made stale, never spawns an agent. |
| B7 | **Activity ahead.** With the track installed and a `practice` step that has `ahead`, main queues one background author job for that concept and difficulty, whose brief asks for `ahead`. It is the same job (same key) a later `author` step for that target starts, so a pass while it runs starts no second one. Test: a first-try pass after the ahead activity is saved opens the next activity from Continue with no new job; a pass while it is being written shows that job's progress on Practice. |
| B8 | **The series.** The course view gives each topic its activities the learner has checked, and the one on offer, oldest first, each with its number (§4.15) and whether it is passed, and an activity written ahead isn't among them until it is on offer. The card, the topic page and the activity screen show "Activity N" for the one on offer, and no screen shows "of N" (renderer tests). Choosing a past activity opens it; one not of that topic is refused. A stuck topic opens the activity checked last. |
| B9 | **More practice.** It shows on the topic page of a mastered topic and of the current topic with its activity open, and nowhere else (renderer tests). `morePractice` opens core's `practice` answer, or starts one More practice author job for an `author` answer, and Practice opens the new activity by itself once it is saved. Main refuses a topic core hasn't reached. A check of the activity records an event like any check. |
| B10 | **I know this.** It shows on the topic page, the lesson outline and Practice's waiting screen while the current topic's activity waits only on its lessons, and nowhere else. It records `unlock` once (core B3), then opens the activity or waits for it to be written. The lessons stay listed and readable, and the topic's mastery is unchanged. |
| B11 | **UI rules for 1.1.** Every new screen state passes D15 (no ids, versions, paths or timestamps; agent names only on connect) and D16 (AA, keyboard, screen-reader names, reduced motion). The mock (`CODEMM_MOCK`) shows each new state. |

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
- **1.1.** Core first, as above: `learner` (`ahead`, `more`, `unlock`, exercise status), then `app` and `mcp`. Then main's `live` tests with the fake core and fake agents (the job queue, More practice, unlock, the series), then renderer tests against the mock.
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

- **Lessons:** predict questions, and learner edits of lesson text. Notes stay. (Runnable examples are in 1.0: §4.3.)
- **Usage:** cost per topic. Totals per course and job kind are in 1.0 (§4.12); lesson caching stays (§4.3).
- The prototype's review card and streaks. (Review scheduling itself is in 1.0: core §7, and a topic's past activities are in 1.1: §4.15.)
- **Progress:** streaming install (setup) progress. Setup and jobs show `running`, `done` or `failed`; checks stream progress (§4.8).
- **Assist:** a separate assist-edit job ("Let Codemm edit?"). The tutor explains, and the learner edits.
- **Platforms:** Linux installers, Windows and Linux arm64, Colima, and Podman.
- **Cursor** beyond experimental, and its stream parser.
- **Reviews:** the six-pass review, replaced by one Astra review plus re-checks.

Also deferred:

- Token-level streaming, a model picker, entering credentials inside the app (Sign in starts the agent's own login instead, §3.1), multiple workspaces and course sharing.
- Stronger hidden-data protection against agents with file access, which would need a separate grader account or encrypted storage.
- Practice hooks for terminal Codex and Cursor; protection there stays advisory (core §2).
- A busy row in Check this computer: an engine that never answers shows there as stopped, while setup, jobs and checks say it's busy (§5).
- Naming a refused container's reason (fewer CPUs, the logging driver, file sharing) in a failed setup or a stall, as checks and Run already do: they say "Docker couldn't run that" there, and the app log has the code.
- Reopening Codemm after a restart for WSL (a one-time `HKCU\…\RunOnce` entry). It's a persistent change to the learner's Windows, so it's the owner's call; until then the learner reopens Codemm from Start.
- Passing a brief on stdin instead of as an argument (Claude Code's `-p` and `codex exec -` read it), which would lift the Windows caps on code and problems in briefs (§3.1).
- A PowerShell fallback for the registry `PATH` when a policy blocks reg.exe (§3.1): `[Environment]::GetEnvironmentVariable('Path', 'User')` and `'Machine'`. Windows PowerShell's start can outlast the 2-second deadline on the slow PCs where it would matter, and a policy that blocks registry tools may block PowerShell too, so it waits until a learner hits it.

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
