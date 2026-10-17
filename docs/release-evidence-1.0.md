# Codemm 1.0 release evidence

Recorded on 17 Oct 2026 on macOS (Apple silicon) with Docker Desktop 27.4, from branch `release/1.0`; A15 was rerun later on `main` (see that section). Every call below went through the real `codemm mcp` stdio server (or the `codemm` CLI where noted), using a Codemm home that started empty. The tracks and exercises were written by an agent (Claude) and are not part of Codemm.

## A14: tracks installed by an agent

| Call | Time | Result |
|---|---|---|
| `save_track` | 128.9 s | installed `c@1` |
| `save_track` | 8.4 s | installed `java@1` |
| `save_track` | 9.8 s | installed `python@1` |
| `save_track` | 24.1 s | rejected: Gate "probe pass" failed: the unit pass probe should pass every test: |

The rejected React attempt was an earlier version of the track. Its fixes, a missing Rollup native binary and then a read-only `node_modules`, were made by the author from the gate diagnostics, and the next save installed `react@1` (4.6 s).

## A14: one gated exercise per track

| Course | `save_exercise` | Time |
|---|---|---|
| c-basics | `sum-of-evens` | 3.1 s |
| java-basics | `largest-element` | 8.7 s |
| python-basics | `palindrome` | 5.0 s |
| react-basics | `counter-with-reset` | 11.6 s |

## A14: independent statement review (Astra, gpt-6-astra)

| Exercise | Verdict | Notes |
|---|---|---|
| sum-of-evens | minor issue | All tests and expected outputs match. Statement omits bounds on individual integers and their sum, leaving overflow expectations unclear; this does not affect existing tests. |
| largest-element | consistent | Signature, nonempty arrays, negative values, and maximum at any position are fully specified. |
| palindrome | consistent | Case handling, ignoring non-alphanumeric characters, empty strings, and false results match the tests. |
| counter-with-reset | consistent | Export, prop, test ID, button labels, increment, and reset behavior match the tests. |
| sum-and-difference | consistent | Input bounds, signed subtraction, output order, and exact newline formatting match every expected output. |
| report-number | consistent | Range, zero, multi-digit values, exact label, spacing, and newline match every expected output. |

Reference solutions and mutants were also inspected. No contradictory tests found. Static review only; no files modified.


The minor issue in `sum-of-evens` is in an example exercise, not in Codemm. Add bounds to its statement before reusing it. A person should spot-check the examples before publishing.

## A15: learner journey (Python track, fresh course)

Rerun on 17 Oct 2026 on `main` at `e715f84`, after the starter-check fix, so the trace shows the final behavior. The run used a temp folder and an empty Codemm home with the agent-written `python@1` track from A14 installed by `codemm track add`.

```text
$ codemm init --host claude
Set up <temp>/ws:
  AGENTS.md
  .claude/agents/codemm-author.md
  CLAUDE.md
  .mcp.json
  .claude/settings.json
$ claude -p "...follow AGENTS.md as the tutor... save_roadmap ... next_step ... delegate to codemm-author ... get_exercise ... reply with just the exercise id"
  progress                → No course in this workspace yet.
  save_roadmap py-strings → { "course": "py-strings", "concepts": 2 }
  next_step               → { "kind": "author", "concept": "py.strings", "difficulty": 1, "style": "unit", "track": "python@1" }
  Agent (codemm-author)   → count-vowels-basic
  get_exercise            → statement, main.py, visible test_visible.py
  final reply             : count-vowels-basic
  7 turns, 62 s, no permission denials
events before test: 0 (no log yet)
$ codemm test
  ✗ visible/test_visible.test_hello: fail
      AssertionError: assert 0 == 2
       +  where 0 = count_vowels('hello')
  ✓ visible/test_visible.test_no_vowels_lower: pass
1/2 passed (visible tests only, not recorded)
exit 0
events after test: 0 (no log yet)
$ codemm check   (unedited starter)
  ✗ visible/test_visible.test_hello: fail
      AssertionError: assert 0 == 2
       +  where 0 = count_vowels('hello')
  ✓ visible/test_visible.test_no_vowels_lower: pass
  ✓ hidden #1: pass
  ✗ hidden #2: fail
  ✗ hidden #3: fail
  ✗ hidden #4: fail
  ✓ hidden #5: pass
3/7 passed (unedited starter, not recorded)
Practice "count-vowels-basic" (py.strings, difficulty 1).
exit 0
events after starter check: 0 (no log yet)
$ learner writes a case-sensitive attempt; codemm check
  ✓ visible/test_visible.test_hello: pass
  ✓ visible/test_visible.test_no_vowels_lower: pass
  ✓ hidden #1: pass
  ✗ hidden #2: fail
  ✓ hidden #3: pass
  ✗ hidden #4: fail
  ✓ hidden #5: pass
5/7 passed (recorded)
Practice "count-vowels-basic" (py.strings, difficulty 1).
exit 0
events after wrong attempt: 1
$ learner fixes it; codemm check
  ✓ visible/test_visible.test_hello: pass
  ✓ visible/test_visible.test_no_vowels_lower: pass
  ✓ hidden #1: pass
  ✓ hidden #2: pass
  ✓ hidden #3: pass
  ✓ hidden #4: pass
  ✓ hidden #5: pass
7/7 passed (recorded)
Ask your agent for a new py.strings exercise (difficulty 1).
exit 0
$ codemm status
py-strings: Python strings (python@1)
  · Strings [py.strings] mastery 0.69, difficulty 1
  · Dictionaries [py.dicts] mastery 0.50, difficulty 1
Ask your agent for a new py.strings exercise (difficulty 1).
events at end: 2
$ progress (MCP)
  py.strings: mastery 0.695, difficulty 1, attempts 2, stuck false
  py.dicts:   mastery 0.5,   difficulty 1, attempts 0
  next: { "kind": "author", "concept": "py.strings", "difficulty": 1, "style": "unit", "track": "python@1" }
{"format_version":1,"kind":"check","at":"2026-10-17T13:43:05.577Z","exercise":"count-vowels-basic","concepts":["py.strings"],"difficulty":1,"passed":5,"total":7,"assisted":false}
{"format_version":1,"kind":"check","at":"2026-10-17T13:43:06.957Z","exercise":"count-vowels-basic","concepts":["py.strings"],"difficulty":1,"passed":7,"total":7,"assisted":false}
```

The unedited starter check was graded but left the log empty. The wrong attempt moved mastery 0.5 → 0.564 (`0.5 + 0.3 × (5/7 − 0.5)`), and the pass moved it to 0.695. Difficulty stayed at 1 because the pass wasn't the exercise's first check, and `next_step` asked for a new py.strings exercise because this one is solved. The temp folder and Codemm home were deleted afterwards.

## A16: host round trips

**Claude Code** (`claude -p`, Claude Code 2.1.283, the learner's own plan, API-key variables removed): 5 turns, 70 s, no permission denials. The tutor called `next_step`, delegated to the `codemm-author` subagent, which saved the exercise through every gate, then called `get_exercise`. Final reply:

```text
sum-and-difference
# Sum and Difference
```

**Codex** (`codex exec`, model gpt-6-astra, the learner's own ChatGPT login, Codemm's tools approved for the run with `default_tools_approval_mode`): the tutor's Codemm calls were `get_exercise`×2, `next_step`×2, `progress`×2. It spawned a subagent that saved the exercise through every gate. Final reply:

```text
report-number
# Report a number
```

**Why the replies show a title.** A16's "id only" is the author subagent's reply to the tutor, so the solution and hidden tests can't reach the tutor that way. The Claude Code trace shows the subagent's reply was exactly `sum-and-difference`; Codex's log doesn't show its subagent's reply. The title in the final replies came from each run's prompt, which asked the tutor for "the exercise id and the first line of its statement". The statement is public, so this discloses nothing. In the A15 rerun, the prompt asked for the id alone, and the subagent and the tutor each replied with only `count-vowels-basic`.

**Cursor**: not run. The Cursor CLI on the release machine wasn't signed in, so Cursor remains experimental.

## Before publishing

Do these in order, on the final commit. Codemm is not published until every box is checked.

- [ ] **A14 spot-check by a person** (Gaille): read the six example exercises' statements against their tests, starting with `sum-of-evens` (see the statement review above).
- [ ] **CI is green** on the final commit on `main`.
- [ ] **`npm pack --json`** lists only `dist/`, `README.md`, `LICENSE` and `package.json`.
- [ ] **Clean install of the tarball:** install the packed `.tgz` into an empty prefix and check that `codemm --version` prints `1.0.0`.
- [ ] **The owner's go-ahead** to publish.
- [ ] **Tag:** `git tag -a v1.0.0` on that commit, and push the tag.
- [ ] **Publish** to npm.
