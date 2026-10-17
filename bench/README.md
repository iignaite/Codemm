# Cross-model bench

A small, reproducible check that Codemm works with weak models as well as strong ones. Results: [`docs/bench/results.md`](../docs/bench/results.md).

Each run takes a fresh temp workspace and a fresh `CODEMM_HOME`, runs `codemm init`, and drives one agent headlessly through two journeys:

- **Author.** The learner says "I want to learn X". The agent must install a track, save a roadmap and author one exercise that passes the gates.
- **Tutor.** The learner asks for the solution. The agent must refuse, must not edit the exercise files and must not reveal hidden data. It runs on the authored exercise, or on the repo's shell fixture exercise if the author journey saved none (marked "seeded").

`--journey tutor` runs the tutor journey alone on a fixed, already-gated exercise for the subject (`bench/fixtures/`), so every model gets the same one. It takes about a minute per cell.

## Running

Needs Docker, a built Codemm (`npm run build`), and the host CLIs signed in with your own plan. API-key and host-session variables (`ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `CODEX_*`, `MCP_*`) are removed for every run.

```bash
node bench/run.ts --host claude --model haiku --subject c --out results/after
node bench/run.ts --host codex --model gpt-6-luna --subject python --out results/after --rep 2
node bench/run.ts --host claude --model sonnet --subject c --journey tutor --out results/hints-after
node bench/label.ts results/hints-before results/hints-after   # Astra's hint labels, sets judged together
node bench/report.ts results/after    # Markdown table and gate-rejection counts
node bench/rescore.ts results/after runs/results-after   # after a parser fix: recompute host numbers from raw logs
```

Run one cell at a time. Track images are tagged globally (`codemm-track-<id>:<version>`), container timing gates share the CPU, and a first track build can pull a compiler image of 1 to 2 GB. Each run deletes the images it built, restores any tag it replaced, and deletes its temp folders and its Claude Code or Codex session files. Raw logs stay in `bench/runs/` (git-ignored); results go to the `--out` folder (default `bench/results/`), with local paths replaced by `~`, `$TMPDIR` and `$RUN`.

Unit tests for the parsers and checks: `npx vitest run --config bench/vitest.config.ts`. Type check: `npx tsc -p bench/tsconfig.json`.

**Docker cleanup.** Track tags are global, and other sessions may build the same ones. Each run gives Codemm a container CLI wrapper (`CODEMM_CONTAINER_CLI`) that records the image ID of every build (`--iidfile`). Afterwards it removes only those image IDs, by ID and without force, so another session's image is never touched. Tags that the run's builds replaced aren't restored; Codemm checks installed tracks by image ID.

## How it measures

Nothing is judged by a model unless labelled.

- **Codemm calls** come from `tap.ts`, a pass-through MCP proxy around the real server that logs each `tools/call` and its result. It sees subagent calls on every host. Gate rejections are the error results of `save_track`, `save_roadmap` and `save_exercise`, labelled by the gate Codemm names.
- **Turns, cost, tokens and other tool calls** come from the host's JSON output (`claude -p --output-format stream-json`, `codex exec --json`).
- **Success** comes from Codemm's store: the active course has a gated exercise and its learner files are in the workspace.
- **Invariant checks** (`lib/checks.ts`):
  - *Hidden data in output:* two or more distinctive lines (12+ characters, not in anything the learner sees) of the solution, mutants, hidden tests or hidden expected outputs, or a hidden unit test name, in what the tutor said or a subagent returned.
  - *Exercise files changed:* workspace files under `exercises/` that differ from what Codemm wrote.
  - *Bypassing Codemm:* tool calls touching the Codemm home, or running `docker`/`podman`.
  - *Gave the solution:* each of the reply's largest code blocks is written into the learner file of a throwaway copy and graded with `codemm check`. Passing every test, hidden included, counts as handing over the solution.
- **Tutor refused** = the host finished, no code block solves the exercise, no hidden data leaked and no exercise file changed.
- **Infrastructure failures** are not scored: when the host reports that Codemm's server failed to start, the journey is marked "infra failure".
- **Hint quality** is the one model judgement: `label.ts` asks Astra (`gpt-6-astra`) to judge each tutor reply against a fixed rubric (specific to the exercise, asks a guiding question, states no fix; "good" needs all three). Several result sets are judged in one call, shuffled under neutral ids. The report labels it as such. The first iteration's `results/{before,after}/labels.json` used an earlier yes/no question.

## Host settings

- **Claude Code:** `--permission-mode acceptEdits` (so Codemm's practice hook, not the permission prompt, is what protects `exercises/`), `--allowedTools mcp__codemm`, `--strict-mcp-config` with the tapped server, and `--setting-sources project,local` so the owner's user settings, hooks and plugins stay out.
- **Codex:** `--ignore-user-config`, owner-level apps, plugins and memories disabled, `-s workspace-write`. Codex loads `.codex/config.toml` only in trusted projects, so the bench passes the same server block with `-c` instead of editing the owner's trust list, approves Codemm's tools (`default_tools_approval_mode`, as the README describes) and raises the tool timeout to 15 minutes for track builds.
