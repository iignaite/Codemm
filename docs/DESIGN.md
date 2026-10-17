# Codemm 1.0 design

Status: revised after two Astra design reviews (§13). The longer illustrated design, with research sources and the competitor survey, is the "Codemm Harness" design doc (v0.4, 17 Oct 2026). This file is the authoritative spec for what 1.0 ships.

## 1. What Codemm is

Codemm is an open-source, local-first harness for graded coding practice. It is a **wrapper that ships no languages**. The learner's own coding agent (Claude Code, Codex or Cursor, on the learner's own plan) writes everything:

- the environment for a language or framework (a **track**),
- the **roadmap** (a concept graph),
- the **exercises**.

Codemm runs the sandbox, checks each piece with deterministic gates, grades the learner's attempts and keeps per-concept mastery. Codemm never calls a model and never handles credentials.

**What the gates guarantee:** each exercise is internally consistent and its hidden tests can tell the reference from plausible wrong answers. They do **not** prove that the statement matches the tests. A wrong reference with matching tests passes. Statement quality is the learner's and reviewer's call; an automated independent-solve check is deferred.

## 2. 1.0 scope

### Release requirements (acceptance criteria)

Each item is verified by an automated test unless marked *journey*. Journeys run with real agents before the merge, and their evidence goes in the release notes.

| # | Requirement |
|---|---|
| A1 | Codemm ships no tracks or toolchains. The packed npm artifact contains only `dist/`, `README.md`, `LICENSE` and `package.json`, and no code dispatches on a language or framework name. |
| A2 | `save_track` / `codemm track add` installs `<id>@<version>` only after the track gates pass. The install is atomic and records the image ID. A conflicting `id@version` with different files is rejected. |
| A3 | Both test styles work end to end. `io`: stdin/stdout, with expected outputs written by Codemm from the reference. `unit`: the track's runner writes a results report checked against a fixed test inventory. |
| A4 | `save_roadmap` enforces the roadmap schema and replacement rules (§5). |
| A5 | `save_exercise` runs the exercise gates (§6). On success it commits the exercise to the store, then writes only learner-side files to the workspace. Solutions, mutants, hidden tests and expected hidden outputs never reach the workspace or any tool output. |
| A6 | The judge reports `pass`/`fail`/`error` per test for wrong output, crashes, timeouts, build failures, missing tests and malformed reports. Output is capped while running. |
| A7 | Judge containers run through one function with every flag in §4.3 and are cleaned up on timeout. Adversarial tests prove: no network (with a positive control), no writes to mounted input, process and memory limits hold, output floods are capped, and no owned containers survive a timeout. |
| A8 | Learner rules (§7) are pure functions of the event log, including repeated-pass, assistance and infrastructure-error rules. |
| A9 | CLI: `init`, `doctor`, `track add`, `track rebuild`, `tracks`, `test`, `check`, `status`, `skip`, `assist on|off`, `mcp [--course] [--tools] [--desktop]`, `hook claude`, `--version`. Parsing is strict per command: unknown options, missing values and wrong argument counts are errors. |
| A10 | The MCP server (stdio) exposes `list_tracks`, `save_track`, `save_roadmap`, `get_roadmap`, `next_step`, `save_exercise`, `get_exercise`, `check`, `progress`, `save_lesson`, `get_lesson` and `mark_lesson_read`. A test spawns the **packed** CLI as a real stdio server and calls the tools, with and without `--tools`. |
| A11 | `codemm init [--host claude|codex|cursor]...` sets up the chosen hosts, all three by default (§9). It is idempotent and preserves unrelated config. |
| A12 | Practice mode blocks Claude Code's `Edit`, `Write`, `MultiEdit` and `NotebookEdit` under `exercises/` unless assist mode is on. Elsewhere it is advisory, and the docs say so. |
| A13 | v1 is removed, along with its config and conflicting docs. Build, type check and all tests pass locally and in CI. Version is `1.0.0`. README, migration guide (with tested v1 rollback steps) and release notes are updated. |
| A14 | *Journey:* starting from an empty Codemm home, an agent installs C, Java (JUnit), Python (pytest) and React (Vitest) tracks through Codemm, and at least one exercise per track passes the gates. Each statement is checked against its tests by a reviewer other than its author. A person's spot-check is a release step before publishing, not a merge requirement, because the gates explicitly don't guarantee statement quality (§1). |
| A15 | *Journey:* a learner gets an exercise, runs `test`, fails then passes `check`, and mastery, difficulty and `next_step` change as §7 says. |
| A16 | *Journey:* Claude Code and Codex each complete an author round trip: tutor, then author subagent, then `save_exercise`, then the subagent replies to the tutor with the id only. Cursor is attempted; if it can't be run here, it's marked experimental. |

### Supported matrix for 1.0

- **Verified:** macOS with Docker Desktop, and Linux in CI with Docker.
- **Experimental:** Podman, and Windows through WSL2. The code supports them, but they are not verified here.

### Deferred (not needed for 1.0)

- Human beta (10 learners), the full cross-host model bench and the recommended-model list. These are adoption validation and need people and weeks.
- Independent-solve gate, spaced review, placement quiz, per-test concept tags.
- Practice hooks for Codex and Cursor; protection is advisory there.
- Multi-container tracks, course sharing, any UI, watch mode.
- Publishing to npm or a GitHub release. These need the owner's explicit go-ahead.

## 3. Files and ids

```
$CODEMM_HOME (default ~/.codemm)
  tracks/<id>@<version>/            installed track files + track.json (image id, styles)
  proposals/<id>@<version>/<digest>/  a track proposed in the desktop app, awaiting consent (§4.4) + proposal.json
  courses/<course>/
    course.json                     { format_version, goal, track, style, concepts }
    exercises/<slug>/               full exercise + exercise.json (inventory, expected io outputs)
    lessons/<id>/                   lesson.json, lesson.md (never changed after saving), notes.md (the learner's)
    events.jsonl                    append-only learner events (check, skip, assist, retry, read)
    .lock                           held while mutating this course

<workspace>/                        --workspace if given; otherwise learner commands use the nearest folder with
                                    codemm.json, and every other command (init included) uses the current folder
  codemm.json                       { format_version, course, current, assist }
  exercises/<course>/<slug>/        README.md, learner files, tests/ (visible only)
```

- **Ids.** Track ids, versions, courses, slugs and concept ids match `^[a-z0-9][a-z0-9._-]{0,63}$`, and versions are positive integers. No path is ever built from an unvalidated id.
- **Format versions.** Only the files Codemm writes (`course.json`, `exercise.json`, `track.json`, `lesson.json`, `proposal.json`, `events.jsonl` records, `codemm.json`) carry `format_version: 1`. Loaders reject unknown versions.
- **File maps.** Author input is a file map: `{ "relative/path": "text" }` over MCP, or a directory for the CLI.
  - Paths must be relative, `/`-separated, with no `.` or `..` parts.
  - Track and exercise paths may not contain `:` or have a name ending in `.` or a space (`assertPortablePaths`). These are the cases that break a checkout on Windows; other names Windows rejects are not checked.
  - At most 256 files and 1 MB in total.
  - Directory input may not contain symlinks or special files.
  - Roadmap YAML may be at most 64 KB and 200 concepts.
- **Writing.** Codemm writes only into fresh temp folders that it then renames into place. The exception is workspace materialization: it refuses any path whose existing components include a symlink, and it never overwrites an existing learner file.
- **Subprocesses** always take argument arrays. Codemm never interpolates into a host shell.
- **Known limitation: symlink race.** Node has no directory-anchored, no-follow traversal (`openat`). Codemm checks every ancestor with `realpath` and opens files with `O_NOFOLLOW` and `O_EXCL`. A local process that swaps a parent folder for a symlink in the microseconds between the check and the write could still redirect one write. Such a process already has the learner's own permissions, so it gains nothing.

## 4. Tracks and the judge

### 4.1 Track contract

```
track.yaml
Dockerfile
...files the Dockerfile copies (test scripts, report converters)
probe/<style>/pass/    a correct solution
probe/<style>/fail/    a wrong solution
probe/<style>/tests/   io: NN.in + NN.out (hand-written) · unit: test files
```

```yaml
id: python
version: 1
styles: [io, unit]
files: [main.py]            # learner-editable files
build: "..."                # io only, optional: run once before the cases
run: "..."                  # io: required; reads stdin, writes stdout
test: "..."                 # unit: required; see 4.2
limits: { time_ms: 2000, memory_mb: 256 }   # optional; clamped to the host ceilings in 4.3
```

### 4.2 Running a check

- **One container per test set.** Visible and hidden tests run in separate containers, so code running against visible tests can never read hidden ones. Learner or reference files are copied into a fresh host folder mounted read-only at `/work/src` (the working directory). That set's tests are mounted read-only at `/work/tests`. The only writable location is a size-capped tmpfs at `/tmp`, and `HOME=/tmp`.
- **No output mount.** The driver writes results to stdout as length-framed records (`@@codemm <kind> <name> <exit> <bytes>` followed by exactly that many bytes). The host parses them sequentially and stops reading past the cap.
- **The driver** is a POSIX `sh` script, written by Codemm and run as PID 1 with the entrypoint overridden. It first checks for `sh`, `timeout`, `head`, `wc` and `cat`; a missing utility is a track error.
- **io:**
  1. Run `build` once, with a 60 s limit.
  2. Run `run` per input with `timeout`, capturing stdout to `/tmp`. Output longer than 64 KB is an `error` ("printed more than 64 KB"), never a comparison of the first 64 KB, and a reference that does this fails the gates.
  3. Run `kill -9 -1` after each case so leftover processes can't affect the next one.
  4. Expected outputs never enter the container. The host compares output after converting CRLF to LF and removing trailing whitespace per line and at the end.
- **unit:**
  1. Run `test` with `TESTS=/work/tests` and `OUT=/tmp/report.json`, in that set's own container.
  2. `test` must exit 0 whenever it wrote a valid report, including when tests fail. A non-zero exit or an invalid report is `error`.
  3. A report is `{ "tests": [ { "name", "status": "pass"|"fail"|"error", "message"? } ] }`. It must be non-empty, with unique names.
- **Unit inventory.** When an exercise is verified, Codemm records the reference's test names for each set. At check time, a test missing from the learner's report counts as `error`, and unknown extra names are ignored, so the denominator never shrinks.
- **Known limitation: results can be forged from inside.** The driver (PID 1) holds the container's output stream on a saved descriptor while a case runs. A program running as the same user could write forged frames to it through `/proc/1/fd`. This doesn't weaken host isolation, but it does mean grading is honor-system, consistent with §1 and §2. Tamper-proof grading would need a separate trusted grader and is out of scope for 1.0.
- **Disclosure.** Visible results include messages and program output. Hidden results include only an index and a status: no messages, output or names leave Codemm, in tool output, CLI output or gate diagnostics.

### 4.3 Host-owned sandbox settings

Every judge container gets:

- `--rm`, a unique `--name` and the label `codemm=1`;
- `--network none`;
- `--read-only` and `--tmpfs /tmp:rw,exec,nosuid,nodev,size=256m`;
- `--memory`, with an equal `--memory-swap`, from `min(limits.memory_mb, 2048)`;
- `--cpus 2` and `--pids-limit 256`;
- `--security-opt no-new-privileges` and `--cap-drop ALL`;
- `--user <uid>:<gid>` on POSIX, and `--user 65534:65534` (the unprivileged "nobody") on Windows, which has no uid;
- `--entrypoint /bin/sh`, `--no-healthcheck`, and `--log-opt max-size=1m`.

Other ceilings:

- **Time:** `time_ms` is capped at 30 s per case or test run. The host kills the whole check at `build + Σ cases + 30 s`, then runs `docker rm -f <name>`.
- **Output:** inside the container, program stdout and stderr go to `/tmp` and only bounded slices are framed out. Outside, the host counts stdout and stderr of the container process together; past 4 MB it kills the container.

**Termination reasons** decide whether a run counts:

| What happened | Result | Recorded as an attempt |
|---|---|---|
| A case times out (the driver's `timeout`), crashes, exits non-zero or prints more than 64 KB | that test is `error` | yes |
| Learner code fails to build | every test is `error` | yes |
| The 4 MB stream cap is hit | every test in that set is `error` ("output limit exceeded") | yes |
| The memory limit kills the driver instead of the program: the container exits 137 and the runtime recorded an `oom` event for it | every test in that set is `error` ("memory limit exceeded") | yes |
| The host deadline for the whole set passes, the runtime is missing or stops during the run, the container is killed from outside (any other non-zero exit), or the image is missing or changed | the command fails with an infrastructure error | no |
- **Memory:** every track or learner command first raises its own `oom_score_adj`, so the kernel kills the program rather than the driver, and that case is an `error`. If the driver dies anyway, the runtime's `oom` event tells a memory kill from an outside one. The runtime can miss that event when a container exits quickly, and then the check counts as an infrastructure failure: nothing is recorded, never a wrong attempt.
- **Volumes:** images that declare `VOLUME` are rejected at install.

`codemm doctor` checks the container CLI and daemon. It also proves `--network none` blocks a host TCP server that a networked container can reach.

### 4.4 Installing a track (a separate trust boundary)

**Building runs code the agent wrote, with network access**, much like running `npm install` from someone else's project.

- **The trust point** is the learner approving the `save_track` call in their agent, or running `codemm track add` themselves. Codemm's tool description says this plainly, and `init` never pre-approves it.
- **In the desktop app** (`codemm mcp --desktop`), `save_track` only proposes. It runs track gate 1 and stores the files as an immutable proposal named by their digest (SHA-256 over the file map sorted by path), replacing older proposals for the same `id@version`, and builds nothing. The learner consents in the app, and `installProposal(ref, digest)` re-reads the files under the track lock, refuses unless their digest is the one the learner was shown, checks that 5 GB is free under `$CODEMM_HOME`, and installs exactly like `save_track`. A failed install keeps the proposal, so retrying needs no new consent. Approving a roadmap never builds anything.
- **The build context** is a fresh folder holding only the track's files. No secrets, SSH agent or Docker socket are forwarded.
- **The build** times out after 10 minutes and the process is killed. Build resource limits are not enforced in 1.0 (a known limitation).
- **Infrastructure failures.** A build that fails because the runtime is down, the network is unreachable or the disk is full is reported as that, not as a gate failure, and installs nothing. The agent retries the same files instead of rewriting a correct track.
- **The image** is tagged `codemm-track-<id>:<version>`, and its ID is stored in `track.json`. Every check verifies that the ID still matches. If the image is missing or has changed, the check fails with "Run `codemm track rebuild <id>@<version>`".
- **Base images.** Each `FROM` should pin its image by digest (`image@sha256:…`). An unpinned `FROM` (other than `scratch` or an earlier stage) installs with a warning rather than failing a gate: checks run by the recorded image ID, and a rebuild that pulls a different base must pass every gate below, so an unpinned base can make a rebuild fail but can't change results silently.
- **Rebuild** re-runs the track gates, then re-runs exercise gates 2 to 6 for every stored exercise on the new image. io outputs must also equal the stored expected outputs, and unit inventories must match. Only then is the new image ID recorded. Otherwise rebuild fails and lists the exercises that changed. Nothing rebuilds silently.
- **Locks.** Installs, rebuilds and exercise saves (from validation through commit) hold that track's lock, so an exercise can't be validated on an image that a rebuild is replacing.

## 5. Roadmaps (courses)

```yaml
goal: "Components and state in React"
track: react@1              # a track pinned by version; it may not be installed yet
style: unit                 # the default style for new exercises; must be offered by the track
concepts:
  - { id: react.jsx, title: "JSX", requires: [] }
  - { id: react.state, title: "State with hooks", requires: [react.jsx] }
```

- **First save** creates the course. Concept order in the file is the tie-break order.
- **A draft track.** The track may not be installed yet. Then `next_step` returns `setup` until it is, and the style is checked once it is: `next_step` fails with "Edit the roadmap's style" if the installed track doesn't offer it. Exercises, `get_exercise` and `check` need the installed track.
- **Re-saving** an existing course may change `goal`, titles and order, add concepts, and change `requires` while staying acyclic. Edits keep concept ids, so renaming changes only the title. It may change `track` while the course has no exercises.
- **Re-saving is rejected** if it changes `track` after exercises exist, or removes a concept that an exercise, event or lesson uses.
- **A fresh start.** When a re-save adds a prerequisite to a stuck concept, Codemm appends a `retry` event for it (§7).
- **Saving makes it active:** it sets the course in `codemm.json` for the bound workspace.
- Course ids are global within `$CODEMM_HOME`, so the same course can be opened from any workspace.

### Lessons

- **Saving.** `save_lesson { id, concept, title, markdown }`: the id is new in the course, the concept is in the roadmap, and the Markdown is at most 64 KB. Lessons are static text; nothing in them runs, and they are checked for structure only. A lesson needs the course, not an installed track.
- **Storage.** `lesson.md` never changes after saving. The learner's `notes.md` (at most 64 KB) sits beside it. Writes are atomic and hold the course lock.
- **Reading.** `get_lesson` returns the text and the notes and records nothing. Only an acknowledgement records a read: `mark_lesson_read` appends a `read` event the first time.

## 6. Exercises and gates

```
exercise.yaml                { slug, style?, concepts, difficulty (1..3), hint? }
README.md
starter/<files>              must contain every file in track.files
solution/<files>
mutants/<name>/<files>       2 to 4 wrong solutions
tests/visible/...            io: NN.in only · unit: test files
tests/hidden/...
```

A failure goes back to the caller with the failing gate and capped output. Hidden inputs and expected outputs never appear in diagnostics returned to tools.

**Track gates:**
1. The files are valid, and `id@version` is either new or identical to the installed one, in which case the install is a no-op.
2. The image builds and declares no volumes.
3. For each style, the pass probe passes everything.
4. For each style, the fail probe gets at least one `fail` and no `error`.
5. The pass probe gives identical results twice.

**Roadmap gate:** the schema and §5 rules hold, there are no unknown prerequisites, and there are no cycles (Kahn's algorithm).

**Exercise gates:**
1. **Valid:**
   - the schema validates and the slug is new in the course;
   - the style (defaulting to the course's) is one the track offers;
   - the concepts exist in the roadmap;
   - the learner files are present in starter, solution and every mutant;
   - there are at least 1 visible and 2 hidden tests, and 2 to 4 mutants.
2. **Reference passes:**
   - io: no `error` on any input, and identical output on two runs, which becomes the expected output;
   - unit: everything passes on two runs with identical results, which becomes the inventory.
3. **Reference is fast:** it still passes with a third of the time limit.
4. **Starter is unsolved:** the starter does not pass everything.
5. **Mutants are caught:** each mutant fails or errors on at least one hidden test. A copy of the reference is caught by this gate too.
6. **Hidden tests matter:** at least one mutant passes every visible test.

**Commit point.** After the gates pass, the exercise folder is renamed into the store under the course lock. Learner files are then materialized into the workspace. `get_exercise`, `test` and `check` re-materialize any missing learner files, so a crash between the two steps is recoverable.

## 7. Learner model

`events.jsonl` is the only learner state. It holds `check`, `skip`, `assist`, `retry` and `read` events, and everything below is recomputed by replaying them in order.

- **`check` event:** `{ kind: "check", at, exercise, concepts, difficulty, passed, total, assisted }`. It is recorded only when grading completed. Infrastructure failures record nothing: no container runtime, a missing image, or a host-side kill of the whole check. Learner-caused outcomes are graded, as `error`: build failures, timeouts and output floods. A check whose learner files are byte-identical to the starter is graded and shown but no `check` event is recorded (`recorded: false`): it isn't an attempt, so it can't count toward the fail streak, lower mastery or take the first try. Assistance and the current exercise are still updated as for any check.
- **`skip` event:** `{ kind: "skip", at, concept }`. "Come back later": it defers the concept until its next `check` and never changes mastery, so it never satisfies a prerequisite or finishes a course.
- **`retry` event:** `{ kind: "retry", at, concept }`. It resets the concept's fail streak, so a stuck concept isn't stuck, and leaves mastery and difficulty unchanged (§5).
- **`read` event:** `{ kind: "read", at, lesson, concept }`. The learner acknowledged a lesson. It never changes mastery.
- **`assist` event:** `{ kind: "assist", at, exercise }`. It marks that exercise as assisted for good, in every workspace.

For each `check`, in order, for each concept it lists:

1. **First try:** the first `check` of this exercise.
2. **Repeat pass:** a perfect check on an exercise that already has a perfect check. It changes nothing (no mastery, no difficulty, no streak), so re-checking a solved exercise can't inflate mastery.
3. **Mastery** moves only on an exercise's first check, or when its score beats that exercise's best so far. Re-running the same partial solution adds nothing. On those checks, `m += 0.3 × w × (s − m)`, where `s = passed/total`, `w` is 1, or 0.25 if assisted, and m starts at 0.5. A concept is mastered at `m ≥ 0.85`.
4. **Perfect check:** sets `failStreak = 0`. If it was the first try and unassisted, difficulty goes up by 1 (max 3, starting at 1).
5. **Otherwise:** `failStreak += 1`. If `failStreak ≥ 2` and difficulty > 1, difficulty goes down by 1 and `failStreak` resets to 0.
6. **Stuck:** a concept is stuck while difficulty is 1 and `failStreak ≥ 2`.

**Assistance.** A check is assisted if assist mode is on in the workspace, or the course log has an `assist` event for that exercise. While assist mode is on, Codemm records an `assist` event for every exercise that becomes current (`get_exercise`) or is checked, unless that exercise already has one. Turning assist mode off doesn't remove them.

**Next step**, in order:

1. If the roadmap's track isn't installed, return `setup` with the track.
2. Candidates are concepts that aren't mastered and whose prerequisites are all mastered, in topological order with ties broken by roadmap order.
3. Among candidates that aren't deferred, take the lowest mastery; the first in order wins ties. If every candidate is deferred, take the first in order.
4. If that concept is stuck, return `stuck`.
5. Otherwise, if an exercise exists for that concept at its current difficulty with no perfect check, return `practice`. The earliest-created such exercise wins.
6. Otherwise return `author` with the concept, difficulty and the course style.
7. If there are no candidates, return `done`.

`practice` and `author` carry a `lesson` field: `null` when the concept has no lesson yet, the id of the earliest unread lesson, or absent once every lesson for the concept is read. The tutor teaches first until it is absent. Lessons never change mastery.

**Corrupt log.** A truncated final line, from a crash mid-append, is ignored when reading. Before the next append, the log is backed up to `events.jsonl.bak-<time>` and the torn line is removed. Any other invalid line makes state-changing commands fail with the line number until it's repaired.

## 8. Interfaces

The MCP tools and CLI commands are thin calls into one application module.

| Tool | Input | Output |
|---|---|---|
| `list_tracks` | — | installed tracks: id, version, styles |
| `save_track` | `files` | `{ installed: "id@v", warning? }` or diagnostics; with `--desktop`, `{ proposed: "id@v", note }` (§4.4) |
| `save_roadmap` | `course`, `roadmap` (YAML text) | ok or errors |
| `get_roadmap` | — | `{ course, goal, track, style, concepts }` |
| `next_step` | — | `setup` / `practice` / `author` / `stuck` / `done` |
| `save_exercise` | `files` | `{ exercise: slug }` only, or diagnostics |
| `get_exercise` | `slug?` | statement, learner file paths, visible tests, hint |
| `check` | `slug?` | per-test results (hidden tests: index and status only), `recorded`, `note?` |
| `progress` | — | mastery and difficulty per concept, next step |
| `save_lesson` | `id`, `concept`, `title`, `markdown` | `{ lesson: id }` or errors |
| `get_lesson` | `id` | `{ id, concept, title, markdown, notes }`; records nothing |
| `mark_lesson_read` | `id` | ok; records a `read` event once |

**Per-job servers.** `codemm mcp --course <course>` makes course-scoped tools use that course instead of the workspace's active one, and `save_roadmap` may save only that course. `--tools <a,b>` registers only the listed tools. With neither option the server behaves as above.

**App functions without tools** (the desktop app calls them in-process): `listLessons`, `saveNotes`, `listExercises`, `listProposals`, `installProposal`, `dropProposal`, `readLearnerFiles` and `writeLearnerFile`. `writeLearnerFile(ws, slug, path, text, digest)` accepts only the exercise's track files, holds the workspace lock, refuses symlinked paths, and replaces the file through a temp file and a rename only if its current digest is the one the editor loaded ("Changed outside Codemm").

## 9. Host setup (`codemm init`)

`init` writes only the files for the selected hosts, under the workspace lock.

- **Merging:** it merges with existing files, replacing only Codemm's own entries and sections. In a shared hook group it removes only Codemm's own hook entry. TOML is parsed and the result re-validated.
- **Writes:** every file is prepared and validated before any is written. Each is then replaced atomically, never through a symlink.
- **Launch commands** use absolute paths and pass `--workspace <abs>`.

| File | Contents |
|---|---|
| `AGENTS.md` | A marked Codemm section with tutor rules: never write the learner's solution, use the tools, author through the subagent, and report only the exercise id. |
| `CLAUDE.md` | Claude Code: create it if needed and make sure it has an `@AGENTS.md` import line. Claude Code prefers `CLAUDE.md` files, including ones in parent folders, over `AGENTS.md`. |
| `.claude/agents/codemm-author.md` | The author instructions. Cursor reads it, and the `AGENTS.md` section tells Codex to spawn a subagent with them. |
| `.mcp.json` | Claude Code's MCP config. |
| `.claude/settings.json` | Claude Code's `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit`, running `codemm hook claude`. |
| `.codex/config.toml` | Codex's `[mcp_servers.codemm]` block. Codex needs the project to be trusted. |
| `.cursor/mcp.json` | Cursor's MCP config. |

**The hook:**
- It reads Claude Code's hook JSON from stdin and resolves `tool_input.file_path` against the workspace.
- If the path is under `exercises/` and assist mode is off, it exits 2 with a message telling the agent to give hints instead.
- Malformed input is allowed through (exit 0) with a warning. The hook is a practice aid, not a security boundary.

## 10. Failure handling

- **No container runtime:** commands that need one fail and say what to do on that OS. When none is installed, they say what to install (`runtimeHelp`): Docker Desktop on macOS; Docker Desktop with the WSL 2 backend set to Linux containers on Windows; Docker Engine on Linux. When one is installed but not running, they say how to start it (`startHelp`). A Docker Desktop running Windows containers is reported as such. `doctor` says which part failed.
- **Locks** (per course and per track): the file is created exclusively and records the owner's PID. A lock whose PID is no longer running is stale and removed. A second writer waits up to 10 minutes, then gets "Course is busy; retry."
- **Leftover containers:** found by the `codemm=1` label. Each container also carries its owner's PID (`codemm.pid`). `doctor --fix` removes only containers whose owner is gone, verifies they're gone, and reports listing or removal failures.
- **`doctor`'s network check** passes only when an ordinary container reaches the test server and the sandbox doesn't. Anything else is reported as a failure ("inconclusive"), never as success.
- **Unexpected errors** reach tools and the CLI only as a generic message; details appear with `CODEMM_DEBUG=1`. Damaged records are reported by file name, never by content.

## 11. Compatibility, migration and rollback

- **v1 data.** 1.0 shares no code or data with v1 and never touches v1's data:
  - v1 kept its database at `<workspace>/.codemm/codemm.db`, or at the path in its workspace override.
  - It fell back to Electron's userData folder, where it also kept encrypted API keys.
- **No migration.** v1 progress is not imported: v1 concepts were free-text tags, and 1.0 concepts are roadmap ids.
- **Coexistence.** 1.0 writes `codemm.json` and `exercises/` in a workspace and `~/.codemm/{tracks,courses}`. None of these collide with v1's files.
- **Rollback.** `docs/MIGRATION.md` gives tested steps to run v1 from commit `5e3f3a7` in a separate checkout (`git worktree add`, `npm ci`, `npm run dev`). The repo-level rollback is reverting the 1.0 merge commit.
- **Future format changes** must migrate forward and keep a backup of the original files.

## 12. Tests

- **Unit (vitest):**
  - file and id validation; schemas;
  - output normalization and frame parsing;
  - learner rules; roadmap rules;
  - init merging; hook decisions; lock behavior.
- **Docker integration**, with a POSIX-shell fixture track in both styles:
  - the judge, every gate, and the adversarial sandbox cases in A7;
  - atomic install and recovery;
  - these run in CI on Linux and locally where Docker is available.
- **Packaging:** `npm pack`, then install the tarball into a temp folder, run `codemm --version`, and spawn `codemm mcp` as a real stdio server and call its tools.
- **Journeys A14 to A16**, with real agents.

## 13. Review log

**Astra (gpt-6-astra), design review, 17 Oct 2026.** Verdict: "not ready for implementation as written". All findings were accepted and resolved in this document:

| Finding | Resolution |
|---|---|
| F01 build security | §4.4 trust boundary, staged context, no secrets, timeout; build resource limits listed as a known limitation |
| F02 symlinks and paths | §3 no symlinks in input, fresh temp folders, guarded materialization; §4.2 no output mount |
| F03 resource exhaustion | §4.2 and §4.3 host ceilings, capped streaming output, log cap, input size limits |
| F04 image behavior | §4.2 entrypoint override, utility check, `kill -9 -1` between cases; §4.3 no healthcheck, volumes rejected, host deadline |
| F05 unit grading | §4.2 report contract, exit-code rule, fixed inventory |
| F06 reproducibility | §4.4 pinned image ID and explicit rebuild; §5 courses pin `track@version` |
| F07 atomicity and concurrency | §6 commit point and re-materialization; §10 locks |
| F08 roadmap contract | §5 schema and replacement rules |
| F09 event semantics | §7 `check`/`skip` events and ordered rules; stuck before practice |
| F10 mastery inflation | §7 repeat passes earn nothing |
| F11 assistance | §7 sticky per exercise |
| F12 errors versus outcomes | §7 infrastructure failures record nothing; corrupt-log rules |
| F13 hook claims | A12 narrowed; §9 |
| F14 host setup | §9 `CLAUDE.md` import, explicit workspace, per-host init |
| F15 verification claims | §1 narrowed guarantee; A14 manual statement check |
| F16 sandbox acceptance | A7 adversarial tests with a positive network control |
| F17 support claims | A10 packed-artifact stdio test; A16 per-host journeys; §2 supported matrix |
| F18 v1 migration | §11 all v1 locations, tested rollback; A13 removes conflicting docs and config |
| Cuts | The vocabulary blacklist, strictly increasing versions and versioning of agent-authored files were dropped; `init --host` was added |

**Astra re-check, 17 Oct 2026.** 9 resolved, 9 partly resolved, 2 new major issues. Resolutions:

| Item | Resolution |
|---|---|
| F03 build allowance, output cap | §4.2 60 s build limit; §4.3 kill and error at 4 MB |
| F04 unit set transition | §4.2 one container per test set |
| F06 rebuild | §4.4 rebuild re-validates every stored exercise before recording the new image |
| F07 track locks, lock expiry | §4.4 per-track lock; §10 PID-based staleness instead of age |
| F10 identical partial retries | §7 mastery moves only on a first check or an improved best score |
| F11 assistance across workspaces | §7 `assist` events in the course log |
| F12 torn final line | §7 back up and repair before the next append |
| F14 ancestor `CLAUDE.md` | §9 always ensure a workspace `CLAUDE.md` with the import |
| New: truncated output false pass | §4.2 output over 64 KB is an error |
| New: hidden tests leaking through visible diagnostics | §4.2 separate containers per set and a disclosure policy |

**Astra final review, 17 Oct 2026.** No correctness or security blockers; CI green on the exact head commit. Two acceptance gaps were fixed:

- **A9:** the `--version` and `--help` aliases are now validated like other commands.
- **A15:** the recorded journey now includes `codemm test`.

The independent statement review of six agent-written exercises found five consistent and one minor gap in an example. Evidence: `docs/release-evidence-1.0.md`.

**Astra entry-point and integration reviews, 17 Oct 2026.** Resolved:

- unexpected-error and record-error sanitizing;
- atomic, locked, symlink-safe and fully pre-validated `init`, with structural TOML editing and per-entry hook removal;
- owner-aware, verified `doctor` with inconclusive network checks;
- a strict CLI parser and the cwd binding for `init`;
- canonical, component-wise hook paths with a shape warning;
- hidden-path redaction in validation errors;
- case-insensitive name collisions;
- atomic no-clobber learner files;
- infrastructure failures (no frames or runtime connection errors) recorded as nothing;
- assist evidence before permission;
- one version bound;
- a full eight-tool stdio round trip;
- precise rollback claims.

A14's person-check became a release step (above).

**Astra second re-check, 17 Oct 2026.** Five narrow gaps, no new major issues. Resolutions:

| Item | Resolution |
|---|---|
| F03 stderr outside the limit | §4.3 stdout and stderr counted together; container output is framed and bounded |
| F06 rebuild could keep a weakened exercise | §4.4 rebuild re-runs exercise gates 2 to 6 |
| F07 rebuild racing an exercise save | §4.4 exercise saves hold the track lock |
| F11 assist across exercise switches | §7 an `assist` event for every exercise made current or checked while assist mode is on |
| F12 contradictory classification | §4.3 termination-reason table |
