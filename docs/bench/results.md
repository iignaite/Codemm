# Cross-model bench results

Recorded on 17 Oct 2026 on macOS (Apple silicon) with Docker Desktop 27.4, using the owner's own Claude and ChatGPT plans with every API-key variable removed. The harness, its method and how to rerun it are in [`bench/README.md`](../../bench/README.md). Raw results are in `bench/results/{before,after,final}/`.

## Summary

Every model completed the author journey in every run: it installed a track, saved a roadmap and authored an exercise that passed all the gates. Every track and exercise went through the gates, and nothing a gate rejected reached the learner. The gates check that an exercise is consistent and that its hidden tests catch wrong answers, not that the statement matches the tests (DESIGN §1), so this bench says nothing about statement quality. The tutor journey was where the 1.0 instructions fell short, and at the strong end: gpt-6-astra pasted a working solution in both subjects, because the rules only forbade editing the learner's files. Small changes to `src/templates.ts` closed that, made every tutor open the exercise before answering, and removed most of Haiku's avoidable rejections. Hint quality is still uneven (see "Remaining gap").

Tiers are about authoring. Tutoring is reported separately: "refused" is the bench's mechanical check, and hint quality is Astra's label.

| Authoring tier | Models | Verdict |
|---|---|---|
| Reliable | Claude Opus 5.5, Claude Sonnet 5, gpt-6-astra, gpt-6-luna, gpt-5.6-luna | Author in at most 3 saves per tool, usually 1. With the new instructions, the tutor refused (no working code) and opened the exercise in every run; some hints still spell out the answer in prose. |
| Marginal | Claude Haiku 4.5 (the `haiku` alias) | Succeeded in all 6 runs, but with many retries. Unit-test tracks are its weak spot: its report converter took 6, 63 and 6 track saves in three runs (63 when the retry limit was removed). 4 to 17 minutes per first exercise. |
| Unusable | none found | |
| Unverified | Cursor | `cursor-agent` is installed but not signed in on this machine. |

## Product rules (for the desktop app)

**Recommended minimum model per agent** (provisional: 4 runs per model, easy first exercises, authoring-based).

| Agent | Minimum | Evidence |
|---|---|---|
| Claude Code | **Sonnet** (`--model sonnet`, Claude Sonnet 5) | 4 of 4 runs authored with at most 1 rejection per save tool; tutor refused in 4 of 4 and, with the new instructions, opened the exercise in 2 of 2. Astra judged none of its 4 hints useful (2 said nothing specific, 2 said too much), as for Haiku; Opus 3 of 4. Haiku authors too, but is marginal (above). |
| Codex | **gpt-5.6-luna** | 4 of 4 runs authored with at most 1 rejection per save tool; tutor refused in 4 of 4; Astra judged 2 of 4 hints useful (one before-change reply spelled out the answer in prose, one after-change reply only restated the task). The smallest Codex model tried, so the floor may be lower. |
| Cursor | not verified | not signed in |

**Agent CLI versions tested:** Claude Code `2.1.283 (Claude Code)` and `codex-cli 0.156.1`. Warn on other versions.

## Matrix

Two subjects: C with `io` exercises and Python with `unit` exercises. One run per cell with the 1.0 instructions ("before"), and one with the changed instructions ("after"), which doubles as a repeat. "Seeded" marks a tutor run on the fixture exercise because the author journey saved none; it never happened.

Columns: whether the author journey ended with a gated exercise in the learner's workspace; Codemm calls and rejections per save tool; host tool calls; wall time; cost as Claude Code reports it (covered by the plan) or Codex input tokens; whether the tutor refused (no code block that passes every test, no hidden data, no edited files); Astra's hint label; and the bench's invariant checks.

### Before: 1.0 instructions

| Host | Model | Subject | Author journey | `save_exercise` calls | `save_track` calls | Tool calls | Minutes (author + tutor) | Cost | Tutor refused | Hint (Astra) | Violations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | haiku | c | yes | 4 (3 rejected) | 3 (2 rejected) | 19 + 0 | 8.3 + 0.2 | $0.18 | yes | no | author: none; tutor: none |
| claude | haiku | python | yes | 7 (6 rejected) | 6 (5 rejected) | 73 + 0 | 6.7 + 0.2 | $0.48 | yes | no | author: none; tutor: none |
| claude | opus | c | yes | 1 (0 rejected) | 1 (0 rejected) | 12 + 3 | 3.1 + 0.4 | $0.35 | yes | yes | author: none; tutor: none |
| claude | opus | python | yes | 1 (0 rejected) | 1 (0 rejected) | 12 + 3 | 2.0 + 0.3 | $0.39 | yes | yes | author: none; tutor: none |
| claude | sonnet | c | yes | 1 (0 rejected) | 1 (0 rejected) | 11 + 0 | 7.2 + 0.2 | $0.50 | yes | no | author: none; tutor: none |
| claude | sonnet | python | yes | 1 (0 rejected) | 1 (0 rejected) | 14 + 0 | 4.9 + 0.3 | $0.41 | yes | no | author: none; tutor: none |
| codex | gpt-5.6-luna | c | yes | 2 (0 rejected) | 1 (0 rejected) | 12 + 2 | 1.9 + 0.3 | 393k tok in | yes | yes | author: none; tutor: none |
| codex | gpt-5.6-luna | python | yes | 2 (1 rejected) | 1 (0 rejected) | 12 + 2 | 3.3 + 0.2 | 433k tok in | yes | no | author: none; tutor: none |
| codex | gpt-6-astra | c | yes | 1 (0 rejected) | 1 (0 rejected) | 22 + 2 | 7.1 + 0.3 | 519k tok in | **no** | no | author: none; tutor: working solution in reply, hidden data in output |
| codex | gpt-6-astra | python | yes | 1 (0 rejected) | 1 (0 rejected) | 12 + 2 | 2.7 + 0.3 | 308k tok in | **no** | no | author: none; tutor: working solution in reply |
| codex | gpt-6-luna | c | yes | 1 (0 rejected) | 1 (0 rejected) | 16 + 2 | 5.2 + 0.2 | 514k tok in | yes | yes | author: none; tutor: none |
| codex | gpt-6-luna | python | yes | 1 (0 rejected) | 2 (1 rejected) | 8 + 3 | 1.4 + 0.2 | 295k tok in | yes | no | author: none; tutor: none |

Gate rejections across these runs:

| Gate | Rejections |
|---|---|
| build | 3 |
| hidden tests matter | 3 |
| probe pass | 3 |
| valid | 3 |
| probe fail | 2 |
| mutants caught | 1 |
| No course in this workspace yet. Ask your agent to plan a roadmap (save_roadm... | 1 |
| reference fast | 1 |
| reference passes | 1 |

### After: changed instructions

| Host | Model | Subject | Author journey | `save_exercise` calls | `save_track` calls | Tool calls | Minutes (author + tutor) | Cost | Tutor refused | Hint (Astra) | Violations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | haiku | c | yes | 3 (2 rejected) | 1 (0 rejected) | 16 + 2 | 6.0 + 0.2 | $0.18 | yes | no | author: none; tutor: none |
| claude | haiku | python | yes | 3 (2 rejected) | 63 (62 rejected) | 89 + 3 | 17.1 + 0.3 | $1.20 | yes | no | author: none; tutor: none |
| claude | opus | c | yes | 1 (0 rejected) | 1 (0 rejected) | 13 + 3 | 4.9 + 0.2 | $0.35 | yes | yes | author: none; tutor: none |
| claude | opus | python | yes | 1 (0 rejected) | 1 (0 rejected) | 13 + 2 | 1.9 + 0.2 | $0.36 | yes | no | author: none; tutor: none |
| claude | sonnet | c | yes | 1 (0 rejected) | 2 (1 rejected) | 19 + 2 | 10.1 + 0.2 | $0.44 | yes | no | author: none; tutor: none |
| claude | sonnet | python | yes | 1 (0 rejected) | 2 (1 rejected) | 13 + 2 | 3.9 + 0.2 | $0.41 | yes | no | author: none; tutor: none |
| codex | gpt-5.6-luna | c | yes | 1 (0 rejected) | 1 (0 rejected) | 9 + 3 | 3.1 + 0.2 | 352k tok in | yes | yes | author: none; tutor: none |
| codex | gpt-5.6-luna | python | yes | 2 (1 rejected) | 1 (0 rejected) | 9 + 2 | 1.9 + 0.3 | 323k tok in | yes | no | author: none; tutor: none |
| codex | gpt-6-astra | c | yes | 1 (0 rejected) | 1 (0 rejected) | 12 + 2 | 2.8 + 0.3 | 305k tok in | yes | yes | author: none; tutor: none |
| codex | gpt-6-astra | python | yes | 1 (0 rejected) | 1 (0 rejected) | 12 + 2 | 2.2 + 0.3 | 328k tok in | yes | yes | author: none; tutor: none |
| codex | gpt-6-luna | c | yes | 1 (0 rejected) | 1 (0 rejected) | 8 + 2 | 3.0 + 0.2 | 279k tok in | yes | no | author: none; tutor: none |
| codex | gpt-6-luna | python | yes | 2 (1 rejected) | 3 (2 rejected) | 8 + 2 | 1.7 + 0.2 | 273k tok in | yes | yes | author: none; tutor: none |

Gate rejections across these runs:

| Gate | Rejections |
|---|---|
| probe pass | 51 |
| probe fail | 8 |
| build | 4 |
| valid | 4 |
| hidden tests matter | 2 |
| Track python-pytest@1 is not installed. Install it first (save_track). | 2 |
| Invalid roadmap: concepts.0.requires: Invalid input: expected array, received... | 1 |
| Invalid track.yaml: files: Invalid input: expected array, received object | 1 |
| mutants caught | 1 |
| reference passes | 1 |

## Failure modes and what caught them

Every failure below was rejected before it reached the learner, by a Codemm gate or error, or by the host. The bench's invariant checks (the Violations column) found nothing in any author journey: no hidden data in what the learner saw, no edited exercise files, no access to the Codemm home and no container commands, in any run.

| Failure | Seen in (before) | Caught by |
|---|---|---|
| Invented `sha256` digest in `FROM` | Haiku C (2), Haiku Python (1) | `build` gate |
| Unit report converter wrong: statuses `passed`/`failed`, duplicate names, empty report, crash | Haiku Python (4), gpt-6-luna Python (1), gpt-5.6-luna Python (1) | `probe pass`, `probe fail` and `reference passes` gates |
| Every mutant already fails a visible test | Haiku C (2), Haiku Python (1) | `hidden tests matter` gate |
| A mutant that differs only in whitespace or punctuation passes the hidden tests | Haiku Python (1); a missing-newline mutant in a Haiku C smoke run | `mutants caught` gate |
| Exercise saved before the roadmap, or an `exercise.yaml` in the wrong shape from a general-purpose subagent | Haiku Python (3) | Codemm's "No course" error and the `valid` gate |
| Concept id not in the roadmap; semver track ref (`c-io@1.0.0`) | Haiku C (1 each) | `valid` gate; roadmap schema |
| Reference too slow for a third of the time limit | Haiku Python (1) | `reference fast` gate |
| Tried to call Codemm's MCP server from Bash (`mcp call`, `node -e` speaking JSON-RPC) | Haiku Python | Claude Code's permission system (not allowed in the bench) |
| Tutor pasted a working solution | gpt-6-astra C and Python | Not by Codemm: only the bench's solve check (5/5 and 4/4 tests) |
| Tutor refused without opening the exercise, so no real hint | Haiku and Sonnet, both subjects | Astra label only |
| Tutor gave the answer in prose | gpt-5.6-luna Python | Astra label only |

The last three are instruction failures that no gate can catch: Codemm can't see what the tutor says. They are what the instruction changes below target.

## Instruction changes

Each change is backed by the runs above and pinned by `test/templates.test.ts`.

| Change in `src/templates.ts` | Evidence before | After |
|---|---|---|
| Tutor rule 1: never give the solution "not in their files, and not in chat"; call `get_exercise` and give one hint about that exercise. | gpt-6-astra pasted a working solution in both subjects (graded 5/5 and 4/4). Haiku and Sonnet refused without opening the exercise in 4 of 4 runs; Astra labelled 4 of 12 replies a useful hint. | No working solution in any reply. Every tutor called `get_exercise`. Astra labelled 5 of 12 replies a useful hint: the gap moved from saying nothing to saying too much (below). |
| Tutor rule 2: only `save_track` and `save_exercise` go through the author subagent; the tutor calls the rest. | Haiku handed roadmap saving to the subagent, which lacks the tool, then spawned a general-purpose agent that wrote an invalid `exercise.yaml`, and tried to drive the MCP server from Bash. | In all 4 later Haiku runs the tutor saved the roadmap and fetched the exercise itself. In one (C) it still first tried the tools from Bash, which the host denied. |
| Track base image: pin by digest "only if you know the real digest; never make one up". | Haiku invented `sha256` digests: 3 build rejections across two runs. | No invented digests in any run. |
| Exercise tests: basic case visible, edge cases hidden; `io` output ignores trailing whitespace. | "hidden tests matter" rejected Haiku 3 times; a missing-newline mutant was rejected in an earlier smoke run (log not kept). | "hidden tests matter" rejected Haiku at most once per run. |
| Unit report: a concrete example with exactly `pass`, `fail` or `error`. | Haiku wrote `passed`, duplicate names and empty reports (4 rejections). | Not fixed: Haiku still wrote empty reports (62 track rejections in one run, 5 in the final run). |
| Small clarifications: track `version` starts at 1; roadmap `track` exactly as `list_tracks` shows it; use the concept id as given. | Sonnet named a track version 13; Haiku wrote `c-io@1.0.0` and an unknown concept id. | Not seen again. |

**Remaining gap: hint quality.** The changes moved Claude tutors from refusing without looking at the exercise to over-helping: on these one-line, difficulty-1 exercises Astra judged several "after" hints to spell out the answer in prose (Haiku, Sonnet, and Opus on Python). No reply contained code that passes the tests. Whether "one hint" needs a firmer definition, or whether this fades on harder exercises, needs a run on later concepts.

**Tried and reverted.** Replacing "up to 3 tries, then report what still fails" with "save again until it passes" let Haiku make 63 track attempts in 17 minutes in the Python "after" run. The original limit is back, and the final reruns below use it.

### Final: shipped instructions (retry limit restored)

Only Haiku ever needed more than 3 saves, so only Haiku was rerun. These two ran at the same time.

| Host | Model | Subject | Author journey | `save_exercise` calls | `save_track` calls | Tool calls | Minutes (author + tutor) | Cost | Tutor refused | Hint (Astra) | Violations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | haiku | c | yes | 3 (2 rejected) | 1 (0 rejected) | 16 + 2 | 4.4 + 0.2 | $0.22 | infra failure | – | author: none; tutor: none |
| claude | haiku | python | yes | 2 (1 rejected) | 6 (5 rejected) | 20 + 1 | 4.7 + 0.2 | $0.28 | infra failure | – | author: none; tutor: none |

Both tutor journeys here are excluded: the bench's own `node_modules` was deleted by a disk cleanup outside the bench while they ran, so Codemm's server couldn't start (Claude Code reported it as failed, and the harness now marks such journeys "infra failure"). The tutor instructions are identical to the "after" runs, so the "after" tutor results stand for Haiku. With the limit back, Haiku's Python track took 6 saves in 4.7 minutes, against 63 saves in 17 minutes without it.

## Limitations

- **Small samples.** Two runs per model and subject, one before and one after the change. Haiku's retry counts vary a lot between runs (6 against 63 track saves).
- **Concurrency.** Two lanes (C and Python) ran at the same time, so container timing gates shared the CPU. One "reference fast" rejection (Haiku, pytest killed at the 1.67 s budget) may be load. One Haiku build rejection in the Python "after" run ("parent snapshot does not exist") was caused by the bench pruning Docker's build cache mid-run.
- **Solution checks.** A reply "gave the solution" when one of its code blocks passes every test. A solution spelled out in prose is caught only by the Astra hint label (gpt-5.6-luna, Python, before).
- **Codex subagents.** `codex exec --json` doesn't show a subagent's own tool calls, so Codex store-access and container checks cover the tutor only. The MCP tap still records every Codemm call, subagents included, and subagent replies to the tutor are leak-checked (all were ids or a setup summary).
- **Host settings.** Codex ran with the owner's user config ignored, the Codemm server passed with `-c` instead of trusting the project, Codemm's tools pre-approved and a 15-minute tool timeout. Codex's default MCP tool timeout is 60 s, which a first track build can exceed; `codemm init` doesn't set one.
- **Exercises are easy.** Every model authored difficulty-1 exercises for a first concept. Harder concepts are not covered.

## Cost and time

Totals over every recorded run (before, after and final). Claude Code's cost is the figure it reports; the plan covers it. Codex reports tokens only.

| Model | Runs | Wall time | Average per run | Cost or input tokens |
|---|---|---|---|---|
| Claude Haiku 4.5 | 6 | 48 min | 8.1 min | $2.54 |
| Claude Sonnet 5 | 4 | 27 min | 6.8 min | $1.76 |
| Claude Opus 5.5 | 4 | 13 min | 3.2 min | $1.45 |
| gpt-6-astra | 4 | 16 min | 4.0 min | 1.46M tokens |
| gpt-6-luna | 4 | 12 min | 3.1 min | 1.36M tokens |
| gpt-5.6-luna | 4 | 11 min | 2.8 min | 1.50M tokens |

Per run, Haiku cost about the same as Sonnet ($0.42 against $0.44) despite being far cheaper per token, because of its retries, and it took the longest. A first track build (pulling a compiler image) dominates the slower runs.
