# Changelog

## 1.0.0-beta.1 (unreleased)

The first beta of the Codemm desktop app, built on the 1.0 core below. The installers are unsigned, so each needs one extra step to open: Open Anyway on macOS, and More info, then Run anyway, on Windows.

- **The desktop app** for macOS (Apple silicon and Intel) and Windows (x64). It connects your agent, checks this computer, researches a roadmap you can edit, sets up the track, and takes you through lessons, activities and progress, with your agent as the tutor beside them.
- **Installing what's missing.** When Claude Code, Codex or Docker isn't on the computer, the app can install it, then starts the agent's own sign-in.
- **Live progress.** Every long step (research, setup, lessons, activities and checks) shows its stage and its latest step while it runs.
- **Run in a terminal pane.** An io activity's program runs in the sandbox with typed input and a time limit, and nothing is recorded. Try it and Check print each visible test in the pane as it finishes; hidden tests show only an index and a status.
- **Usage.** The course map shows the tokens your agent reported for the course, and Claude's own cost estimate when it gives one.
- **Auto-update.** The app checks GitHub Releases at start and every 6 hours. An unsigned build says when a new version is out and links to it; a signed build downloads it and offers Restart to update.

## 1.0.0 (unreleased)

Codemm 1.0 is a rewrite. The v1 desktop app is replaced by a small, open-source harness that your own coding agent drives. See [docs/MIGRATION.md](docs/MIGRATION.md) for what this means for v1 users.

### What's new

- **Your agent writes, Codemm verifies.** Claude Code, Codex or Cursor writes tracks (language or framework environments), roadmaps and graded coding exercises on your own plan. Codemm never calls a model and never handles credentials.
- **Codemm ships no languages.** Any language or framework that builds and tests headless in one Linux container can be installed as a versioned track (`id@version`), once, and shared by every course.
- **Two test styles.** `io` (stdin/stdout; Codemm writes the expected outputs from the reference) and `unit` (the track's own test runner; for example JUnit, pytest or Vitest).
- **Verification gates.**
  - **Tracks** must build, have no `VOLUME`, and pass their probes deterministically with the network off.
  - **Exercises** need:
    - a deterministic reference that is fast enough;
    - an unsolved starter;
    - 2–4 mutants, each caught by a hidden test;
    - hidden tests that catch something the visible ones don't.
- **Adaptive learning.**
  - A per-concept mastery score, replayed from an append-only log.
  - Re-checking a solved exercise or repeating the same partial answer adds nothing.
  - Assisted attempts count a quarter as much.
  - Difficulty steps up after a first-try pass and down after two failures, and `stuck` and prerequisite-aware `next_step` tell the tutor what to do.
- **Sandbox.** One function starts every container with:
  - network off and a read-only root;
  - memory, CPU and process limits;
  - no capabilities and no privilege escalation;
  - KILL timeouts, output caps and bounded cleanup.

  `codemm doctor` proves the network is blocked against a positive control.
- **Host setup.** `codemm init` configures Claude Code, Codex and Cursor (MCP, an `AGENTS.md` section, the author subagent, and a Claude Code practice hook that stops the agent editing your exercise files) without overwriting existing config.

### Fixed before release

Two defects found in a live end-to-end run with Claude Code were fixed before 1.0.0 was published:

- **A check of the unedited starter is no longer recorded.** It is still graded and shown, with `recorded: false` and the note "unedited starter, not recorded". Before, checking the starter once and then making one real wrong attempt reported "stuck"; it also lowered mastery and used up the exercise's first try.
- **Unpinned base images now get a warning.** `save_track` and `codemm track add` still install a track whose `FROM` isn't pinned by digest, and return a `warning` naming the image. Checks already run by the recorded image ID, and a rebuild re-runs every gate, so this only affects whether a later rebuild can reproduce the image.

### Removed

- The Electron and Next.js desktop app, the built-in Java, Python, C++ and SQL judges, the chat-to-spec pipeline, LLM provider routing, API-key storage and Ollama management.

### Verification for this release

- **Automated:** 210 tests across unit, Docker integration, multi-process locking and the packed npm artifact. They cover every gate, adversarial sandbox cases (network with a positive control, read-only mounts, fork bomb, memory, output flood, programs that ignore SIGTERM, leftover containers) and the disclosure rules.
- **Real tracks**, written by an agent (Claude) and installed through the MCP server from an empty Codemm home:

  | Track | Styles | Install time |
  |---|---|---|
  | `c@1` | io; gcc with AddressSanitizer and UBSan | 129 s |
  | `java@1` | io, unit; JUnit 5 | 8 s |
  | `python@1` | io, unit; pytest | 10 s |
  | `react@1` | unit; Vitest and Testing Library | 5 s |

  The React track was rejected twice by the probe gate, for a missing Rollup native binary and a read-only `node_modules`, and fixed by the author each time, as designed.
- **One exercise per track** passed every gate through MCP: C 3.1 s, Java 8.7 s, Python 5.0 s, React 11.6 s.
- **Learner loop** (per-track runs, made before the starter-check fix; the A15 rerun below covers the final behavior):
  - the unedited starter fails (these runs recorded it, which the fix stops);
  - the solution passes;
  - mastery changes exactly as specified for the recorded checks: Java 0.5 → 0.35 → 0.545, React 0.5 → 0.55 → 0.685;
  - a first-try pass raises difficulty;
  - a repeat pass changes nothing;
  - hidden tests show only an index and a status.
- **Host round trips (A16).** Each was started by the host's own CLI on its own signed-in plan, with API-key variables removed.
  - **Claude Code:** the tutor called `next_step` and delegated to the `codemm-author` subagent. The subagent saved `sum-and-difference` (`c.io`, difficulty 1, 5 hidden cases including overflow) through every gate. The subagent replied to the tutor with only the id. The tutor then called `get_exercise` and replied with the id and the statement's title, as the run's prompt asked. 5 turns, 70 s.
  - **Codex** (gpt-6-astra, with Codemm's tools approved for the run): the tutor spawned a subagent that saved `report-number` (`c.io`, difficulty 1) through every gate, then called `get_exercise` and replied with the id and the statement's title, as the run's prompt asked.
  - **Statement checks:** the statements and tests of all six exercises were checked independently by Astra. Five are consistent; one example has a minor gap (unstated integer bounds) that doesn't affect its tests. A person should spot-check them before publishing.
- **Recorded learner journey (A15),** rerun on the final code. `codemm init`, then Claude Code saved a roadmap and its author subagent saved `count-vowels-basic`. The subagent and the tutor each replied with only the id. Then `codemm test` (visible only, nothing recorded), a `check` of the unedited starter (graded, not recorded), a wrong `check` and a passing `check`, both recorded. Mastery went 0.5 → 0.564 → 0.695, difficulty stayed at 1 because the pass wasn't a first try, and `next_step` asked for a new exercise.
- **Full traces:** [docs/release-evidence-1.0.md](docs/release-evidence-1.0.md).
- **Reviews:** the design and the implementation were reviewed by Astra (gpt-6-astra) over several rounds, and every blocker and major finding was resolved (see [docs/DESIGN.md §13](docs/DESIGN.md)).
- **Rollback:** verified. At commit `5e3f3a7`, v1's `npm ci`, build and 84 unit tests pass.

### Known limitations

- Grading is on the honor system: code inside the sandbox can read its own test set and could forge its result. Track builds have network access and no resource limits. The practice hook covers only Claude Code's edit tools. See [docs/SECURITY.md](docs/SECURITY.md).
- Verified on macOS with Docker Desktop and on Linux in CI. Podman and Windows (WSL2) are experimental. Cursor's CLI wasn't signed in on the release machine, so the Cursor round trip is unverified.
- Not yet published to npm. Install from source (see the README).
- Deferred to 1.x:
  - a human beta;
  - the full cross-host model benchmark and recommended-model list;
  - the independent-solve gate;
  - spaced review;
  - a placement quiz;
  - multi-container tracks;
  - Codex and Cursor practice hooks.
