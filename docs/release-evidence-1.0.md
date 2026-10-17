# Codemm 1.0 release evidence

Recorded on 17 Oct 2026 on macOS (Apple silicon) with Docker Desktop 27.4, from branch `release/1.0`. Every call below went through the real `codemm mcp` stdio server (or the `codemm` CLI where noted), using a Codemm home that started empty. The tracks and exercises were written by an agent (Claude) and are not part of Codemm.

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

```text
$ save_roadmap (course py-journey, track python@1)
{
  "tool": "save_roadmap",
  "text": "{\n  \"course\": \"py-journey\",\n  \"concepts\": 2\n}"
}
$ next_step
{
  "tool": "next_step",
  "text": "{\n  \"kind\": \"author\",\n  \"concept\": \"py.strings\",\n  \"difficulty\": 1,\n  \"style\": \"unit\",\n  \"track\": \"python@1\"\n}"
}
$ save_exercise (palindrome)
{
  "tool": "save_exercise",
  "text": "{\n  \"exercise\": \"palindrome\"\n}"
}
$ get_exercise palindrome
{
  "tool": "get_exercise",
  "text": "{\n  \"course\": \"py-journey\",\n  \"exercise\": \"palindrome\",\n  \"path\": \"/private/tmp/claude-501/codemm-journey/ws-a15/exercises/py-journey/palindrome\",\n  \"style\": \"unit\",\n  \"concepts\": [\n    \"py.strings\"\n  ],\n  \"difficulty\": 2,\n  \"files\": [\n    \"main.py\"\n  ],\n  \"statement\": \"# Palindrome\\n\\nWrite `is_palindrome(text)` in `main.py`. It returns `True` when `text` reads the same forwards and backwards,\\nignoring case and anything that isn't a letter or a digit. An empty string is a palindrome.\\n\\n`is_palindrome(\\\"Racecar\\\")` → `True`; `is_palindrome(\\\"ab\\\")` → `False`.\\n\",\n  \"hint\": \"Keep only letters and digits (str.isalnum), lowercase them, then compare with the reversed string.\",\n  \"visibleTests\": [\n    {\n      \"name\": \"test_visible.py\"\n    }\n  ]\n}"
}
events before test: 0 (no log yet)
$ codemm test   (CLI, from the exercise folder)
  ✗ visible/test_visible.test_mixed_case_word: fail
      AssertionError: assert None is True
       +  where None = is_palindrome('Racecar')
0/1 passed (visible tests only, not recorded)
exit 0
events after test: 0 (test is never recorded)
$ codemm check  (unedited starter)
  ✗ visible/test_visible.test_mixed_case_word: fail
      AssertionError: assert None is True
       +  where None = is_palindrome('Racecar')
  ✗ hidden #1: fail
  ✗ hidden #2: fail
  ✗ hidden #3: fail
0/4 passed (recorded)
Ask your agent for a new py.strings exercise (difficulty 1).
exit 0
$ learner writes a solution; codemm check
  ✓ visible/test_visible.test_mixed_case_word: pass
  ✓ hidden #1: pass
  ✓ hidden #2: pass
  ✓ hidden #3: pass
4/4 passed (recorded)
Ask your agent for a new py.strings exercise (difficulty 1).
exit 0
$ codemm status
py-journey: Python strings (python@1)
  · Strings [py.strings] mastery 0.55, difficulty 1
  · Dictionaries [py.dicts] mastery 0.50, difficulty 1
Ask your agent for a new py.strings exercise (difficulty 1).
$ progress (MCP)
{
  "tool": "progress",
  "text": "{\n  \"course\": \"py-journey\",\n  \"goal\": \"Python strings\",\n  \"track\": \"python@1\",\n  \"concepts\": [\n    {\n      \"id\": \"py.strings\",\n      \"title\": \"Strings\",\n      \"requires\": [],\n      \"mastery\": 0.545,\n      \"mastered\": false,\n      \"difficulty\": 1,\n      \"attempts\": 2,\n      \"stuck\": false\n    },\n    {\n      \"id\": \"py.dicts\",\n      \"title\": \"Dictionaries\",\n      \"requires\": [\n        \"py.strings\"\n      ],\n      \"mastery\": 0.5,\n      \"mastered\": false,\n      \"difficulty\": 1,\n      \"attempts\": 0,\n      \"stuck\": false\n    }\n  ],\n  \"next\": {\n    \"kind\": \"author\",\n    \"concept\": \"py.strings\",\n    \"difficulty\": 1,\n    \"style\": \"unit\",\n    \"track\": \"python@1\"\n  }\n}"
}
events at end: 2
{"format_version":1,"kind":"check","at":"2026-10-17T08:06:11.710Z","exercise":"palindrome","concepts":["py.strings"],"difficulty":2,"passed":0,"total":4,"assisted":false}
{"format_version":1,"kind":"check","at":"2026-10-17T08:06:13.016Z","exercise":"palindrome","concepts":["py.strings"],"difficulty":2,"passed":4,"total":4,"assisted":false}
```

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

**Cursor**: not run. The Cursor CLI on the release machine wasn't signed in, so Cursor remains experimental.

