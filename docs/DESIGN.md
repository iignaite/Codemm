# Codemm 1.0 design

Status: revised after two Astra design reviews (§13). The longer illustrated design, with research sources and the competitor survey, is the "Codemm Harness" design doc (v0.4, 17 Oct 2026). This file is the authoritative spec for the core that 1.0 ships. The desktop app that bundles it, and the core features the app needs, are specified in [desktop/DESIGN.md](desktop/DESIGN.md).

## 1. What Codemm is

Codemm is an open-source, local-first harness for graded coding practice. It is a **wrapper that ships no languages**. The learner's own coding agent (Claude Code, Codex or Cursor, with the learner's own account) writes everything:

- the environment for a language or framework (a **track**),
- the **roadmap** (a concept graph),
- the **exercises**.

Codemm runs the sandbox, checks each piece with deterministic gates, grades the learner's attempts and keeps per-concept mastery. Codemm launches the learner's own agent CLI (in the desktop app); it never calls a model API, and it never reads, stores or asks for credentials.

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

- **Desktop app:** macOS (Apple Silicon and Intel) and Windows 11 x64, with Docker Desktop. Its journeys with real agents on packaged builds (desktop D17 and D18) come before the private beta.
- **Terminal, verified:** macOS with Docker Desktop (A14 to A16), and Linux in CI with Docker. Core unit tests also run on Windows in CI.
- **Experimental:** Podman and other engines with a Docker-compatible CLI (Colima, Rancher Desktop, OrbStack), and terminal use on Windows through WSL 2. The code supports them, but they are not verified with a real agent. What they share with the verified engine is that the self-test (§4.3) proves the engine can mount Codemm's run folders.

The desktop app, the private beta and the minimum model per agent are in scope for 1.0 ([desktop/DESIGN.md](desktop/DESIGN.md), [beta-plan.md](desktop/beta-plan.md)). The minimum models come from a small bench of the terminal flow ([bench/results.md](bench/results.md)); the desktop's per-job flow isn't benchmarked yet.

### Deferred (not needed for 1.0)

- The full cross-host model bench, including the desktop's per-job flow.
- Independent-solve gate, placement quiz, per-test concept tags.
- Practice hooks for Codex and Cursor in the terminal; protection is advisory there.
- Multi-container tracks, course sharing, watch mode.
- For heavy tests: per-exercise time limits (the track's `time_ms` applies to every exercise), running a check's test sets in parallel, a runner that stays warm across io cases (each case starts `run` afresh), and a unit `build` step timed apart from `test`.
- Publishing to npm. GitHub releases are built as drafts, and only the owner publishes them.

## 3. Files and ids

```
$CODEMM_HOME (default ~/.codemm)
  tracks/<id>@<version>/            installed track files + track.json (image id, styles)
  proposals/<id>@<version>/<digest>/  a track proposed in the desktop app, awaiting consent (§4.4) + proposal.json
  courses/<course>/
    course.json                     { format_version, title?, goal, track, style, concepts }
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

- **One container per test set.** Visible and hidden tests run in separate containers, so code running against visible tests can never read hidden ones. Learner or reference files are copied into a fresh host folder (a run folder, §4.3) mounted read-only at `/work/src` (the working directory). That set's tests are mounted read-only at `/work/tests`. The only writable location is a size-capped tmpfs at `/tmp`, and `HOME=/tmp`.
- **No output mount.** The driver writes results to stdout as length-framed records (`@@codemm <kind> <name> <exit> <bytes>` followed by exactly that many bytes). The host parses them sequentially and stops reading past the cap.
- **The driver** is a POSIX `sh` script, written by Codemm and run as PID 1 with the entrypoint overridden. It first checks for `sh`, `timeout`, `head`, `wc` and `cat`; a missing utility is a track error.
- **io:**
  1. Run `build` once, with a 60 s limit.
  2. A generated input (`NN.gen`, §6) is written first: the driver runs the script with `sh`, at most 30 s and outside the case's time limit, into `/tmp/in`, which is removed after the case. If a generator fails, the program doesn't run. Gate 2 reports it, and the reference's fast run (gate 3) gives each generator a third of its 30 s, so a later run has room. A failure in any later run isn't the solution's doing: gates 4 to 7 fail the save rather than count a mutant as caught, and a check or test records nothing (§4.3).
  3. Run `run` per input with `timeout`, capturing stdout to `/tmp`. Output longer than 32 MB is an `error` ("printed more than 32 MB"), never a comparison of the first 32 MB, and a reference that does this fails the gates.
  4. Run `kill -9 -1` after each case so leftover processes can't affect the next one.
  5. Expected outputs never enter the container. The host compares output after converting CRLF to LF and removing trailing whitespace per line and at the end. It reads the frames as they stream and keeps only the first 64 KB of each case's output, for messages and Results; the comparison uses the SHA-256 of all of it, normalized, hashed as it comes (only a line's trailing whitespace waits), so a long output is never held whole. It reads at most three frames per case plus two; more were forged and are ignored. An expected output over 64 KB is recorded the same way: its digest, its size and its first 64 KB.
- **unit:**
  1. Run `test` with `TESTS=/work/tests` and `OUT=/tmp/report.json`, in that set's own container.
  2. `test` must exit 0 whenever it wrote a valid report, including when tests fail. A non-zero exit or an invalid report is `error`.
  3. A report is `{ "tests": [ { "name", "status": "pass"|"fail"|"error", "message"? } ] }`. It must be non-empty, with unique names.
- **Unit inventory.** When an exercise is verified, Codemm records the reference's test names for each set. At check time, a test missing from the learner's report counts as `error`, and unknown extra names are ignored, so the denominator never shrinks.
- **Known limitation: results can be forged from inside.** The driver (PID 1) holds the container's output stream on a saved descriptor while a case runs. A program running as the same user could write forged frames to it through `/proc/1/fd`. This doesn't weaken host isolation, but it does mean grading is honor-system, consistent with §1 and §2. Tamper-proof grading would need a separate trusted grader and is out of scope for 1.0.
- **Progress.** `testExercise` and `checkExercise` take an optional callback with `{ phase, done, total }`:
  - `phase` is `building`, `visible` or `hidden`;
  - io reports the build, then each visible test as it finishes, counted from the frames as they stream;
  - each visible io test also arrives with its result (`test`: name, status, message and output, graded as Results grades it), so the app can print it as it finishes. Only visible cases are handed over; hidden ones only count. The final grade still decides: an output flood or a memory kill afterwards makes every test an error;
  - hidden tests, and unit tests (whose runner reports at the end), report their phase once with `total` 0, so nothing per hidden test, not even timing, leaves;
  - a listener that throws is dropped, and the check goes on.
  Code in the container could print extra frames, but that can only move progress, never a grade.
- **Learner-facing words.** Messages name the learner's files as they know them (`/work/src/main.py` is `main.py`, `/work/tests/x` is `tests/x`), in results and in Run's streamed errors, and say how a program ended in words ("It stopped with an error", "The build failed"), never an exit code. Gate diagnostics for authors keep exit codes.
- **Disclosure.** Visible results include messages and program output. Hidden results include only an index and a status (`{ name: "hidden #2", index: 2, status }`, built in one place, `grading.redact`): no messages, output or names leave Codemm, in tool output, CLI output or gate diagnostics. The reference is hidden code too, so its gate diagnostics carry no build output, errors or test messages (§6). That costs authors detail by design: in the desktop an author job has only Codemm's tools and can't build the reference itself, so each reference failure says which phase and which visible tests failed, and what to check.

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

**Run folders.** The files a container mounts (the learner's or reference files, the tests) are staged on the host before it starts.
- **Where:** `<real path of $CODEMM_HOME>/runs/<pid>-<random>`, one folder per container run, made by `stageRunFolder` (`src/runs.ts`). The OS temp folder is never used. Engines that run in a VM share only the home folder with it by default (Colima, Rancher Desktop, Podman), not macOS's `/var/folders`, so a bind mount from there fails with exit 125 ("the container couldn't start") while the self-test, which mounted nothing, passed.
- **The real path** (`realpathSync.native`) is what the engine is asked to mount, so a linked home, a Windows short name (`JOHNSM~1`) and a non-ASCII user folder are mounted by the name that exists.
- **Created and removed by the run that owns it.** `mkdtemp` makes the folder, empty and private, and it is filled before the container starts. The run removes it when the container is gone, whatever the result. A removal that fails (Windows, while the engine lets go) is retried and then left, never a failure of the run.
- **Leftovers.** The folder's name is `<pid>-<six letters or digits>`, so it carries its owner's PID. A run first removes the folders of that name, and that are real folders (not files or links), whose owner process is gone, as `doctor --fix` removes containers whose owner is gone (§10). A live process's folders are never touched, and neither is anything else in `runs/`.
- **Hidden data.** A run folder holds hidden tests while its check runs (after a crash, until the next run removes it), and only under `$CODEMM_HOME`, where hidden data already lives. The desktop's agent has no file access, and a terminal agent that does is under the same advisory limits as for the rest of Codemm's files (§1).
- A `$CODEMM_HOME` that the engine can't see (outside its shared folders) fails the self-test below, with the folder to share, instead of every check.

Other ceilings:

- **Time:** `time_ms` is capped at 120 s per io case or per unit test run (the whole `test` command, compiling included). The host kills the whole set at `build + Σ cases + Σ generators + 30 s`, then runs `docker rm -f <name>`.
- **Output:** inside the container, program stdout and stderr go to `/tmp` and only bounded slices are framed out. Outside, the host counts stdout and stderr of the container process together; past 4 MB, plus 32 MB per io case, it kills the container.

**Limits on the heavy path** (big io, slow tests, heavy stacks). Each is kept, raised or the track's to set, within a bound:

| Limit | Value | Who sets it |
|---|---|---|
| A track's files, an exercise's files (MCP or CLI) | 256 files, 1 MB | fixed; big inputs come from `NN.gen` generators instead |
| Probe example (pass probe + tests) | 64 KB per style | fixed: every author reads it |
| `time_ms` | 100 ms to 120 s, default 2 s: per io case, or a whole unit run | the track |
| `memory_mb` | 64 to 2048 MB, default 256; `/tmp` (256 MB) counts toward it | the track |
| io build, Run's build | 60 s | fixed |
| Input generator | 30 s, outside `time_ms`; a third of it in the reference's fast run | fixed |
| Reference speed (gates) | must pass in a third of `time_ms`; at the ceiling the gate says to make the probe faster | fixed |
| Output per io case | 32 MB; the first 64 KB is kept and shown | fixed |
| Stream per container | 4 MB, plus 32 MB per io case | fixed |
| Unit report | 1 MB; runner log shown 4 KB; each message 2000 characters | fixed |
| Processes, CPUs | 256 PIDs (a JVM build tool with a forked test JVM uses about 20), 2 CPUs | fixed |
| Track build | 10 minutes; 5 GB free to install in the app | fixed |
| Gate runs | one container per test set, sets one after another; the starter, mutant and earlier-solution runs stop an io set at its first error | fixed |
| Run | 120 s, 4 MB of output, typed input 64 KB per write and 1 MB unread | fixed |
| Tool output | a visible test's output and an expected output show at most 64 KB | fixed |

**Termination reasons** decide whether a run counts:

| What happened | Result | Recorded as an attempt |
|---|---|---|
| A case times out (the driver's watchdog, with `timeout` as a backstop), crashes, exits non-zero or prints more than 32 MB | that test is `error` | yes |
| A test's input generator fails during a check (it passed the gates, so this is a slow moment or a program that filled `/tmp` first) | the command fails ("couldn't be generated") | no |
| Learner code fails to build | every test is `error` | yes |
| The stream cap is hit | every test in that set is `error` ("output limit exceeded") | yes |
| The memory limit kills the driver instead of the program: the container exits 137 and the runtime recorded an `oom` event for it | every test in that set is `error` ("memory limit exceeded") | yes |
| The host deadline for the whole set passes, the runtime is missing or stops during the run, the container is killed from outside (any other non-zero exit), or the image is missing or changed | the command fails with an infrastructure error | no |
- **Memory:** every track or learner command first raises its own `oom_score_adj`, so the kernel kills the program rather than the driver, and that case is an `error`. If the driver dies anyway, the runtime's `oom` event tells a memory kill from an outside one. Newer engines (Docker 29) can publish that event a few seconds after the exit, so when the first query finds none, Codemm asks once more 2 s later; only a suspected kill waits. The runtime can still miss the event when a container exits quickly, and then the check counts as an infrastructure failure: nothing is recorded, never a wrong attempt.
- **Why a case was killed:** both kinds of `timeout` exit 137 on a time-out, as a memory kill does, so the exit code can't say which. So a watchdog beside each case (and the unit runner) enforces the limit, as Run's does: it marks the time-out, then `kill -9 -1` stops everything but the driver, and the result says "took longer than N ms". `timeout` backs it up a second later. A 137 without that mark says "ran out of memory (memory_mb N)" when the runtime recorded an `oom` event for the container, else "was killed". The wording never changes the grade.
- **Volumes:** images that declare `VOLUME` are rejected at install.

**Run (interactive).** `runInteractive` runs the learner's io program once, for the app's Run button. It is never graded or recorded.
- **Sandbox:** the same `startSandboxed` path and every flag above. The only addition is `-i`, which keeps stdin open, so typed lines reach the program.
- **What's mounted:** only the learner's files, at `/work/src`. No tests.
- **Driver:** the build, if the track has one (60 s), then the run command, with stdout and stderr streamed as they come.
- **How it ended:** the driver writes short markers to stderr when each stage starts and how it ended, then exits 0. The host strips the markers from what the learner sees. The first start marker of each stage is reported once, with that stage's limit, so the app can count down.
  - An end marker means the driver finished, so the program's own exit code and output are reported as they are, even when they look like Docker's.
  - **Time limits:** 120 s for the run, because a person is typing, and 60 s for the build. Each stage runs in the foreground, keeping stdin, with a watchdog beside it. At the limit the watchdog writes a timeout marker, then `kill -9 -1` stops everything but the driver, which stays PID 1. A timeout is therefore the driver's own statement: it is never read from an exit code or guessed from timing, and it doesn't depend on which `timeout` tool the image has. The watchdog fires only after `sleep` succeeds; if it can't, the host deadline stops the run. Grading checks the image has `sleep`, so installed tracks have it. No shell reports the kill ("Killed"): a shell writes that on the stderr it gave the killed command, so the program takes the real stderr back itself while the driver's goes to `/dev/null`, and the app's own "time's up" is the only word on it.
  - **Memory:** a stage that ends with 137 and didn't time out is checked against the runtime's memory-kill events, so a program killed for memory says so even though the driver went on.
  - No end marker means Codemm stopped it (the learner, the host deadline or the 4 MB cap), the runtime killed it for memory, or Docker failed. Only that last case is an infrastructure failure.
  - A program could forge markers, but only about its own unrecorded run.
- **Input:** typed input is bounded: one write is at most 64 KB, and at most 1 MB may wait unread. Beyond that, and after the end, input is dropped.
- **Failures:** if Docker's connection drops (exit 125), the container is removed with a checked command.
- **Unit tracks:** they have no run command, so they have no Run.

`codemm doctor` checks the container CLI and daemon, then runs the self-test (`networkIsolation`, also Check this computer's last row) in this order:
1. **The test image.** A pinned Alpine image, pulled if it isn't there. A pull that fails because the network is down or blocked (DNS, a blocked or slow connection, a proxy, TLS interception, Docker Hub's rate limit) is reported with `kind: "offline"` and its own words (Docker Hub's limit, an intercepting proxy, a plain network failure), not as "inconclusive". A broken credential helper is `kind: "docker"` with its own words; Codemm's 3-minute deadline and a stopped Podman machine stay inconclusive. An out-of-space pull is `kind: "disk"`; any other failure stays inconclusive, with `kind: "docker"`.
2. **A mount, as a check does it.** A container started through the same sandbox (every flag above) with a staged run folder mounted read-only at `/work/src`, which reads a file back. An engine that can't start it, or can't read the file (a folder it can't see arrives empty), fails here with its own words and the folder to share, `kind: "docker"`, instead of failing every check later. If Codemm can't stage the folder (the home isn't writable), that row fails with that reason and the rest of `doctor` still runs.
3. **Isolation.** A test server runs in an ordinary container, and `--network none` must block it while an ordinary container reaches it. A sandboxed container that never ran its test (the engine refused, or 30 s passed) is inconclusive with the engine's words, never "the sandbox reached the network".

`Check` is `{ name, ok, detail, kind? }`: `kind` (`offline`, `disk`, `docker`) is the cause on this computer, as an error's kind is (§10), so a caller acts on it without reading the words.

### 4.4 Installing a track (a separate trust boundary)

**Building runs code the agent wrote, with network access**, much like running `npm install` from someone else's project.

- **The trust point** is the learner approving the `save_track` call in their agent, or running `codemm track add` themselves. Codemm's tool description says this plainly, and `init` never pre-approves it.
- **In the desktop app** (`codemm mcp --desktop`), `save_track` only proposes. It runs track gate 1 and asks the registry whether each base image in the Dockerfile exists, with one top-level manifest request each (`buildx imagetools inspect --raw`, side by side, so it costs one pull of Docker Hub's rate limit, not one per platform). A tag the registry says it doesn't have, or an official image (no namespace) that isn't there, is refused at once, naming it, so a guessed tag never costs the learner a consent or the agent a proposal. An answer it can't get (offline, no runtime or buildx, a namespaced or private repository it won't show) refuses nothing, and the build reports it. Then it stores the files as an immutable proposal named by their digest (SHA-256 over the file map sorted by path), replacing older proposals for the same `id@version`, and builds nothing. The learner consents in the app, and `installProposal(ref, digest)` re-reads the files under the track lock, refuses unless their digest is the one the learner was shown, checks that 5 GB is free under `$CODEMM_HOME`, and installs exactly like `save_track`. A failed install keeps the proposal, so retrying needs no new consent. Approving a roadmap never builds anything.
- **The build context** is a fresh folder holding only the track's files. No secrets, SSH agent or Docker socket are forwarded.
- **The build** times out after 10 minutes and the process is killed. Build resource limits are not enforced in 1.0 (a known limitation).
- **Install progress.** `installProposal(ref, digest, onProgress?)` reports each build step as counts only (`{ phase: "building", done, total }`, read from BuildKit's `#5 [2/7]`, the legacy builder's `Step 2/7 :` and Podman's `STEP 2/7:`), then `{ phase: "checking" }` before the probes. The build's output never leaves. A listener that throws is dropped, and the install goes on.
- **Infrastructure failures.** A build that fails because the runtime is down or not answering, Docker's credential helper can't run, the network fails or the disk is full is reported as that, not as a gate failure, and installs nothing. The agent retries the same files instead of rewriting a correct track. Network failures are read from the build output, each with what may be behind it: a name or route that fails, or a proxy that refuses (offline, or a VPN, proxy or firewall), Docker Hub's pull rate limit (`toomanyrequests`), an intercepted certificate (one no trusted authority signed: a VPN, proxy or security software; an expired certificate, or one for another name, stays the track's), or a connection that timed out or dropped (`i/o timeout`, `TLS handshake timeout`, `net/http: request canceled`, a download's `unexpected EOF`; a compiler's `unexpected EOF` stays the track's). A gate failure never carries an infrastructure kind or code, whatever its details or output say.
- **The image** is tagged `codemm-track-<home>-<id>:<version>`, where `<home>` is the first 8 hex characters of the SHA-256 of the Codemm home's real path, so two homes on one Docker never share a tag. Its ID is stored in `track.json`, and checks use that ID. A track installed before this naming keeps its old tag, which only `track rebuild` uses. The ID is the one the build itself reports (`--iidfile`), never the tag looked up afterwards, so a concurrent build of the same tag can't swap the image being verified. Every check verifies that the ID still matches. If the image is missing or has changed, the check fails with "Run `codemm track rebuild <id>@<version>`".
- **Base images.** Each `FROM` should pin its image by digest (`image@sha256:…`). An unpinned `FROM` (other than `scratch` or an earlier stage) installs with a warning rather than failing a gate: checks run by the recorded image ID, and a rebuild that pulls a different base must pass every gate below, so an unpinned base can make a rebuild fail but can't change results silently.
- **Rebuild** re-runs the track gates, then re-runs exercise gates 2 to 6 for every stored exercise on the new image. io outputs must also equal the stored expected outputs, and unit inventories must match. Only then is the new image ID recorded. Otherwise rebuild fails and lists the exercises that changed. Nothing rebuilds silently.
- **Locks.** Installs, rebuilds and exercise saves (from validation through commit) hold that track's lock, so an exercise can't be validated on an image that a rebuild is replacing.

## 5. Roadmaps (courses)

```yaml
title: "React"              # optional: the course's name in a few plain words, at most 60 characters
goal: "Components and state in React"
track: react@1              # a track pinned by version; it may not be installed yet
style: unit                 # the default style for new exercises; must be offered by the track
concepts:
  - { id: react.jsx, title: "JSX", requires: [] }
  - { id: react.state, title: "State with hooks", requires: [react.jsx] }
sources:                    # optional: the roadmaps and docs the agent used, at most 10
  - { title: "React docs: Thinking in React", url: "https://react.dev/learn/thinking-in-react" }
```

- **First save** creates the course. Concept order in the file is the tie-break order.
- **Title** is optional: the course's name as the learner would say it, which the desktop app shows (desktop §4.13). Blank space around it is dropped. A course without one is named by its goal.
- **Sources** are optional: at most 10, each a `title` of at most 120 characters and an https `url` with no credentials. The app shows them and opens them only in the learner's browser.
- **A draft track.** The track may not be installed yet. Then `next_step` returns `setup` until it is. Proposing or installing a track that a course names but whose styles lack that course's style is refused, so a course can't be stranded; an install checks this under the track lock, which roadmap saves also take (after the course lock). `next_step` fails with "Edit the roadmap's style" if an installed track still doesn't offer it. Exercises, `get_exercise` and `check` need the installed track.
- **Re-saving** an existing course may change `title`, `goal`, concept titles and order, add concepts, and change `requires` while staying acyclic. Edits keep concept ids, so renaming changes only the title. It may change `track` while the course has no exercises.
- **Re-saving is rejected** if it changes `track` after exercises exist, or removes a concept that an exercise, event or lesson uses.
- **A fresh start.** When a re-save adds a prerequisite to a stuck concept, Codemm appends a `retry` event for it (§7).
- **Saving makes it active:** it sets the course in `codemm.json` for the bound workspace.
- Course ids are global within `$CODEMM_HOME`, so the same course can be opened from any workspace.

### Lessons

- **Saving.** `save_lesson { id, concept, title, markdown, examples? }`: the id is new in the course, the concept is in the roadmap, and the Markdown is at most 64 KB. The text is checked for structure only. A lesson without examples needs the course, not an installed track.
- **Examples.** A lesson may carry up to 5 runnable examples, each a file map of at most 64 KB:
  - Each holds exactly the installed track's learner files; for a unit course, it adds test files under `tests/`.
  - The Markdown places example N as an unindented fence (``` or ~~~) whose info string is `example`, then one line holding N, then the closing fence. A fence inside another fence (which may be indented up to 3 spaces) is shown, never run. Every example is placed, and every placement names an example. Examples hold at most 250 files in all.
  - The lesson records the track and style its examples were checked with, and they always run with those.
  - The gate: under the course lock, then the track lock, each example runs in the track's image exactly as a check runs code, with the same sandbox and limits. io runs the build and run commands once, with empty input; unit runs the test command on the example's tests. Each must exit 0 within the limits. A runtime failure is infrastructure and saves nothing.
  - Examples need the installed track, and `get_roadmap` over MCP includes the track's contract once it's installed.
- **Running.** `runExample(ws, lesson, n)` runs a saved example the same way and returns its exit code, output (capped at 16 KB) and errors (capped at 4 KB). It is never recorded. `runExampleLive(ws, lesson, n, bound, output)` runs an io example interactively instead, as Run does for an activity (`runProgram`): its output streams, and the learner's typed input reaches its stdin. It checks the files against the recorded track first, and is never recorded either. A unit example has no live run.
- **Diagrams.** The Markdown may hold diagrams and charts: top-level fenced blocks (``` or ~~~) whose info string is `mermaid` (flowcharts, sequence, state and class diagrams, pie and xy charts). The text is still checked for structure only: core accepts any fence, never parses or draws one, and a diagram is not an example. The app draws it (desktop §4.3).
- **Storage.** `lesson.md` never changes after saving. The learner's `notes.md` (at most 64 KB) sits beside it. Writes are atomic and hold the course lock.
- **Reading.** `get_lesson` returns the text, the notes and the examples, and records nothing. A lesson with examples also names their `style`, which says how they run. Only an acknowledgement records a read: `mark_lesson_read` appends a `read` event the first time.

## 6. Exercises and gates

```
exercise.yaml                { slug, style?, concepts, difficulty (1..3), hint? }
README.md
starter/<files>              must contain every file in track.files
solution/<files>
mutants/<name>/<files>       2 to 4 wrong solutions
tests/visible/...            io: NN.in, or NN.gen (a POSIX sh script whose output is the input) · unit: test files
tests/hidden/...
```

A failure goes back to the caller with the failing gate and capped output. Hidden inputs and expected outputs never appear in diagnostics returned to tools. Neither does anything the reference or a mutant printed, since building or running them runs hidden code: a reference failure names its phase, exit codes and statuses: visible tests by name (io cases only by the inputs the author gave), hidden ones by number, and a failed build by the track's build command and what to check. A track gate's failure shows the last lines of what the track's own build or probes printed (track files only, never an exercise's), and that output never sets the failure's kind.

**Track gates:**
1. The files are valid, each style's pass probe and probe tests total at most 64 KB (authors receive them as the track's example), and `id@version` is either new or identical to the installed one, in which case the install is a no-op.
2. The image builds and declares no volumes.
3. For each style, the pass probe passes everything.
4. For each style, the fail probe gets at least one `fail` and no `error`.
5. The pass probe passes again with a third of the time limit, as every exercise's reference must (gate 3 below), and gives identical results. A track that fails here is told to raise `limits.time_ms` or `limits.memory_mb`, or, when `time_ms` is already at its ceiling, to make the command faster (cache everything at build time, and call the compiler and test runner directly rather than a build tool).

**Roadmap gate:** the schema and §5 rules hold, there are no unknown prerequisites, and there are no cycles (Kahn's algorithm).

**Exercise gates:**
1. **Valid:**
   - the schema validates and the slug is new in the course;
   - the style (defaulting to the course's) is one the track offers;
   - the concepts exist in the roadmap;
   - the learner files are present in starter, solution and every mutant;
   - there are at least 1 visible and 2 hidden tests, and 2 to 4 mutants;
   - io tests are `NN.in` or `NN.gen`, never both for one `NN`, and no `.out` files.
2. **Reference passes:**
   - io: no `error` on any input, and identical output on two runs, which becomes the expected output;
   - unit: everything passes on two runs with identical results, which becomes the inventory.
3. **Reference is fast:** it still passes with a third of the time limit.
4. **Starter is unsolved:** the starter does not pass everything.
5. **Mutants are caught:** each mutant fails or errors on at least one hidden test. A copy of the reference is caught by this gate too.
6. **Hidden tests matter:** at least one mutant passes every visible test.
7. **New task:** no earlier exercise's solution on the same track passes every visible test. To bound the wait, it compares at most 3 earlier exercises on a shared concept and the 3 most recent others: at most 6 runs of the visible tests. The author sees the earlier exercises' titles and first lines in `next_step`'s `earlier`, never their solutions or tests.

Gates 4 to 7 only ask whether everything passes, so their io runs stop a set at its first error: a slow wrong solution costs one time limit per set, not one per case.

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

**Reviews.** When a check first makes a concept mastered, its first review is due 1 day later. The first check of that concept at or after the due time is the review:

- a perfect check moves to the next interval: 3, then 7, 21 and 60 days after that check. After the 60-day review there are no more;
- any other check lowers mastery below the threshold (to at most 0.75), so the concept is practised again, and mastering it again starts over at 1 day.

Checks before the due time are ordinary checks. A concept that drops below mastery any other way loses its review too.

**Next step**, in order:

1. If the roadmap's track isn't installed, return `setup` with the track.
2. If a mastered concept's review is due, the earliest due first: return `review` with the concept, its difficulty and an exercise of that concept at that difficulty the learner has never checked; if there is none, return `author` with `review: true`.
3. Candidates are concepts that aren't mastered and whose prerequisites are all mastered, in topological order with ties broken by roadmap order.
4. Among candidates that aren't deferred, take the lowest mastery; the first in order wins ties. If every candidate is deferred, take the first in order.
5. If that concept is stuck, return `stuck`.
6. Otherwise, if an exercise exists for that concept at its current difficulty with no perfect check, return `practice`. The earliest-created such exercise wins.
7. Otherwise return `author` with the concept, difficulty and the course style.
8. If there are no candidates, return `done`. A review can still come due later.

`practice` and `author` carry a `lesson` field: `null` when the concept has no lesson yet, the id of the earliest unread lesson, or absent once every lesson for the concept is read. The tutor teaches first until it is absent. Lessons never change mastery.

**Corrupt log.** A truncated final line, from a crash mid-append, is ignored when reading. Before the next append, the log is backed up to `events.jsonl.bak-<time>` and the torn line is removed. Any other invalid line makes state-changing commands fail with the line number until it's repaired.

## 8. Interfaces

The MCP tools and CLI commands are thin calls into one application module.

| Tool | Input | Output |
|---|---|---|
| `list_tracks` | — | installed tracks: id, version, styles |
| `save_track` | `files` | `{ installed: "id@v", warning? }` or diagnostics; with `--desktop`, `{ proposed: "id@v", note }` (§4.4) |
| `save_roadmap` | `course`, `roadmap` (YAML text) | ok or errors |
| `get_roadmap` | — | `{ course, title?, goal, track, style, concepts }` |
| `next_step` | — | `setup` / `review` / `practice` / `author` / `stuck` / `done`; `author` carries the concept's `title`, `style`, `track` and the track's `contract` (learner `files`, the `build`/`run` or `test` command, `limits`, and `examples`: the track's passing probe solution and its tests) |
| `save_exercise` | `files` | `{ exercise: slug }` only, or diagnostics |
| `get_exercise` | `slug?` | statement, learner file paths, visible tests, hint, and for io the track's run command; a generated visible input shows its generator (`generated: true`), and a long expected output its first 64 KB with `expectedBytes` |
| `check` | `slug?` | per-test results (hidden tests: index and status only), `recorded`, `note?` |
| `progress` | — | mastery and difficulty per concept (with `reviewDue` for a mastered concept whose review is scheduled), next step |
| `save_lesson` | `id`, `concept`, `title`, `markdown` | `{ lesson: id }` or errors |
| `get_lesson` | `id` | `{ id, concept, title, markdown, notes, examples, style? }`; records nothing |
| `mark_lesson_read` | `id` | ok; records a `read` event once |

**Per-job servers.** `codemm mcp --course <course>` makes course-scoped tools use that course instead of the workspace's active one, and `save_roadmap` may save only that course. `--tools <a,b>` registers only the listed tools. With neither option the server behaves as above. `--progress <file>` (an absolute path) makes `save_exercise` write which gate is running, `{ "format_version": 1, "gate": "reference" | "starter" | "mutants" }`, replacing the file atomically as each starts, so the desktop app can show it (`saveExercise`'s optional `onProgress` hears the same). Only the gate's name is written.

**Failure codes.** An error for this computer's problem carries a stable code (`src/errors.ts` `INFRA`) and the kind that follows from it: Docker missing or not running (`no-runtime`, `runtime-down`, `runtime-paused`, `socket-permission`, `runtime-context`), up but not answering (`runtime-busy`, `check-timeout`, `container-remove`), answering but failing (`windows-containers`, `credentials`, `container-start`, `docker-cpus`, `docker-log-driver`, `docker-file-sharing`, `runtime-failed`, `image-id`, `image-inspect`, `container-list`), Docker's disk or this computer's (`docker-disk`, `host-disk`), or the network (`offline`, `rate-limit`, `tls`, `network-timeout`). Every failed tool result starts with Codemm's own line, `codemm:<code, kind or error>`, so nothing a message quotes (a build log, a runner, a program, the agent's own files) can stand there. A write that runs out of space reaches the agent as `host-disk`, not as an unexpected error.

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
| `.codex/config.toml` | Codex's `[mcp_servers.codemm]` block, with `tool_timeout_sec = 1800`: Codex's 60-second default is shorter than a track build (up to 10 minutes) or the exercise gates, which on a heavy track (a JVM build tool, `time_ms` near its 120 s ceiling) can pass 15 minutes. Codex needs the project to be trusted. |
| `.cursor/mcp.json` | Cursor's MCP config. |

**The hook:**
- It reads Claude Code's hook JSON from stdin and resolves `tool_input.file_path` against the workspace.
- If the path is under `exercises/` and assist mode is off, it exits 2 with a message telling the agent to give hints instead.
- Malformed input is allowed through (exit 0) with a warning. The hook is a practice aid, not a security boundary.

## 10. Failure handling

- **No container runtime:** commands that need one fail and say what to do on that OS. When none is installed, they say what to install (`runtimeHelp`): Docker Desktop on macOS; Docker Desktop with the WSL 2 backend set to Linux containers on Windows; Docker Engine on Linux. When one is installed but not running, they say how to start it (`startHelp`). A Docker Desktop running Windows containers is reported as such. `doctor` says which part failed.
- **A busy runtime:** `docker info` gets 20 s. An engine that gives no answer, or answers that it isn't ready (a server error or a dropped connection, as Docker Desktop gives while it starts or resumes), is asked once more, a few seconds later, for 60 s. One that still gives no real answer counts as not answering ("may be busy"), never as stopped: under load (a large build, CPU-heavy checks, Docker Desktop resuming from Resource Saver) it can be that slow. An engine that answers, even to refuse, is read at once. A check that reaches the host's deadline, or whose runtime stops answering mid-run, says it may be busy too, and so does the slow answer a memory kill waits on (60 s).
- **A runtime that isn't running** is named from what its CLI said: a paused Docker Desktop, a user without access to the socket, or a CLI context that points at another runtime or doesn't exist. "Stopped" is said only when the runtime itself says so (`runtimeDown`): a container that couldn't start, a run the runtime failed, or a list or inspect that failed while it answers is Docker failing, worded as "try again, and restart Docker if it happens again".
- **A container the runtime refused** (`docker run` exit 125) is named in Codemm's own words from the CLI's error: fewer CPUs than the check's 2, a logging driver that refuses the log options, a folder Docker Desktop doesn't share, Docker's disk, the network. The error text itself never leaves, since code that had started can write to the same stream. Exit 126 or 127 before the driver printed anything is the track image's: it can't run `/bin/sh`.
- **A flood** is graded even when removing its container was slow.
- **Locks** (per course and per track): the file is created exclusively and records the owner's PID. A lock whose PID is no longer running is stale and removed. A second writer waits up to 10 minutes, then gets "Course is busy; retry."
- **Leftover containers:** found by the `codemm=1` label. Each container also carries its owner's PID (`codemm.pid`). `doctor --fix` removes only containers whose owner is gone, verifies they're gone, and reports listing or removal failures. Run folders (§4.3) are owner-aware the same way: the next run removes those of a process that is gone.
- **Reading Docker's answers.** Codemm reads Docker's records (`image inspect`, `inspect`) as JSON (`--format '{{json .}}'`) and picks fields in code, never with a template that names a key: Docker versions leave out empty keys (Docker 29 drops `Config.Volumes` when an image declares none), and a template that names a missing key fails. One reader (`inspectRecord`) takes Docker's and newer Podman's one-line record and Podman 4.3's indented array. CI runs the Docker tests on the runner's Docker and on the newest Docker Engine.
- **`doctor`'s network check** passes only when an ordinary container reaches the test server and the sandbox doesn't. The test server runs in an ordinary container, not on the host, so a host firewall (on by default on many Macs, and asking on Windows) never decides the result. Before that, the test image must download (offline is `kind: "offline"`) and a staged run folder must mount and read back (§4.3). Anything else is reported as a failure ("inconclusive"), never as success.
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
  - heavy tests: a million generated numbers in and out, seconds of CPU per case, and a Maven + JUnit track that builds its cache into the image and runs offline (its image is about 600 MB, so it runs only with `CODEMM_BIG_IMAGES=1`, which CI sets);
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
