# Codemm

CodeChum-style practice for any language or framework, written by **your own coding agent**. Codemm proves every exercise works before you see it, grades your code in a sandbox, and tracks what you've mastered.

Codemm is an open-source harness, not a tutor and not a model. It works with Claude Code, Codex and Cursor on your own plan; there are no API keys and no accounts. **Codemm ships no languages.** Your agent installs each language or framework the first time you need it, and Codemm checks that it works.

```
You:   "Teach me pointers in C."
Agent: plans a roadmap → installs a C track → writes an exercise
Codemm: runs the reference, the starter and deliberately broken variants in a sandbox,
        accepts the exercise only if the tests can tell them apart
You:   solve it in your editor → codemm check → mastery goes up → next exercise
```

## How it works

- **Tracks.** A track is the environment for one language or framework: a Dockerfile, a `track.yaml` and small probe programs. Your agent writes it, and Codemm installs it only after the probes pass with the network off.
- **Roadmap.** A concept graph with prerequisites, written by your agent and checked by Codemm for cycles and unknown concepts.
- **Exercises.** A statement, starter code, a reference solution, 2–4 deliberately wrong variants ("mutants") and visible and hidden tests. Tests are either stdin/stdout cases (`io`) or the framework's own unit tests (`unit`). Codemm accepts an exercise only if:
  - the reference passes twice, and still passes with a third of the time limit;
  - the starter fails;
  - every mutant fails a hidden test;
  - at least one mutant passes the visible tests.
- **Mastery.** Each check moves a concept's score toward your pass rate.
  - **Mastered:** at a score of 0.85, which takes about four distinct good attempts.
  - **What doesn't count:** re-checking a solved exercise adds nothing.
  - **Assisted attempts** count a quarter as much.
  - **Difficulty** steps up after a first-try pass and down after two failures.
- **Practice mode.** In Claude Code, a hook stops the agent from editing your exercise files, so it explains instead of solving. `codemm assist on` lifts the block, and those attempts count for less. In Codex and Cursor this is advisory.

## Requirements

- Node.js 22 or newer.
- Docker Desktop, running. It's free for personal use and education. Podman should work but is not yet verified.
- Claude Code, Codex or Cursor.

Verified on macOS with Docker Desktop, and on Linux in CI. Windows (WSL2) and Podman are experimental.

## Install

Codemm 1.0 isn't on npm yet. Install it from source:

```bash
git clone https://github.com/iignaite/Codemm.git
cd Codemm
npm ci
npm run build
npm link
```

Then check the sandbox:

```bash
codemm doctor
```

## Start learning

In an empty project folder:

```bash
codemm init
```

This sets up Claude Code, Codex and Cursor. Use `--host claude` (repeatable) to pick specific ones. It writes:

- an MCP server entry for each host;
- a Codemm section in `AGENTS.md` (imported into `CLAUDE.md`);
- the `codemm-author` subagent;
- the Claude Code practice hook.

Existing config is merged, never replaced.

Open the folder in your agent and say what you want to learn.

- **Codex** only loads `.codex/config.toml` for projects you've marked as trusted.
- **Codex asks** before each Codemm tool call. To skip those prompts, add `default_tools_approval_mode = "approve"` under `[mcp_servers.codemm]`. That also skips your approval for `save_track`, which runs a network build.

## Commands

| Command | What it does |
|---|---|
| `codemm init [--host claude\|codex\|cursor]` | Set up this project for your agent(s) |
| `codemm doctor [--fix]` | Check Docker and prove the sandbox has no network |
| `codemm status` | Your progress and the next step |
| `codemm test [exercise]` | Run the visible tests (not recorded) |
| `codemm check [exercise]` | Run every test and record the attempt |
| `codemm skip <concept>` | Mark a concept you already know |
| `codemm assist on\|off` | Let your agent edit exercise files (counts for less) |
| `codemm tracks` | List installed tracks |
| `codemm track add <folder>` | Install a track from a folder |
| `codemm track rebuild <id@version>` | Rebuild a removed image and re-verify its exercises |

Your agent uses the MCP tools: `list_tracks`, `save_track`, `save_roadmap`, `next_step`, `save_exercise`, `get_exercise`, `check` and `progress`.

## What to know

- **Installing a track runs code your agent wrote, with network access**, like running `npm install` in someone else's project. Approve `save_track` only for tracks you'd run yourself. Checks and exercises always run with the network off, and with memory, CPU, process and time limits.
- **Grading is on the honor system.** Hidden tests are hidden from your agent's tools, not from you, and code inside the sandbox could fake its own result. Codemm is built for self-learners, not for graded classwork.
- **The gates prove an exercise is consistent, not that its statement is right.** If something reads wrong, tell your agent.
- **Where things live:**
  - Tracks, courses and your attempt history are under `~/.codemm`; set `CODEMM_HOME` to change that.
  - Your workspace holds `codemm.json` and `exercises/`.

## Documentation

- [Design](docs/DESIGN.md): the 1.0 spec, formats, gates and review log
- [Security](docs/SECURITY.md): the sandbox, trust boundaries and known limitations
- [Migrating from v1](docs/MIGRATION.md): what changed, where v1 data lives, how to roll back
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
