# Codemm: instructions for agents working on this repository

Codemm is a harness: the learner's coding agent writes tracks, roadmaps and exercises, and Codemm verifies, grades and tracks mastery. `docs/DESIGN.md` is the authoritative spec. Read it before changing behavior.

## Invariants (never break these)

- **Codemm ships no languages.** No code may dispatch on a language, runtime or framework name, and no track or toolchain may ship in the package.
- **Codemm never calls a model** and never reads or stores credentials.
- **Untrusted code runs only in a sandbox:** containers through `src/sandbox.ts` (every judge container gets the full flag set, DESIGN §4.3), or the WASI engine through `src/wasi.ts` (DESIGN §4.5). Never add a path that runs agent or learner code on the host.
- **Hidden data never leaves Codemm through Codemm's own outputs (tools, CLI, IPC and diagnostics).** An agent with file access can read Codemm's files; Codemm removes that access where the agent allows. Hidden inputs, expected outputs, test names, messages and output must not appear in tool output, CLI output, IPC or gate diagnostics. Hidden results show an index and a status only.
- **Infrastructure failures record nothing.** Learner-caused outcomes (build errors, timeouts, crashes, output floods) are graded as `error` and recorded.
- **Persistence:**
  - The event log is append-only.
  - Writes to Codemm's files are atomic (temp folder or file, then rename).
  - Mutations hold the course, track or workspace lock.
  - Codemm-owned records carry `format_version`.
- **Subprocesses** use argument arrays, never a host shell.

## How to work

- **Test-first.** For a behavior change, write a failing test, make it pass simply, then refactor with tests green.
- **Keep it small.** KISS, YAGNI and single responsibility: prefer deleting to adding, and put anything not needed now in DESIGN §2 "Deferred".
- **One job per module:**

  | Module | Job |
  |---|---|
  | `files` | input validation |
| `toolchain` | a WASI track's toolchain: download, verify, store |
  | `schemas` | formats |
  | `grading` | pure grading |
  | `sandbox` | containers |
| `wasi` | the WASI engine (wasmtime) |
  | `judge` | running test sets |
  | `program` | Run: the learner's program, interactively |
  | `gates` | verification |
  | `learner` | pure learner rules |
  | `store` | persistence |
  | `app` | use cases (`src/app/`, one file per section behind the `app.ts` barrel) |

  `cli`, `mcp`, `init`, `hook` and `doctor` are thin entry points.
- **Never vendor AGPL code.** Exercism's test runners are AGPL-3.0.

## Commands

```bash
npm ci
npm run typecheck
npm run build
npm test              # everything; Docker tests run when Docker is up
npm run test:unit     # no Docker needed
```

CI sets `CODEMM_REQUIRE_DOCKER=1`, so Docker tests can't be skipped there.

## Handoff

For substantial sessions, append to `docs/handoff/YYYY-MM-DD.md`: what changed, how it was verified, and what's next.
