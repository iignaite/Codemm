<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/codemm-logo-dark.svg">
    <img src="docs/brand/codemm-logo.svg" alt="Codemm" width="360">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/emm-dark.svg">
    <img src="docs/brand/emm.svg" alt="Emm, the Codemm chameleon" width="120">
  </picture>
</p>

<p align="center"><strong>Enhance your coding journey with your own coding agent.</strong></p>

<p align="center">
  <a href="https://github.com/iignaite/Codemm/actions/workflows/ci.yml"><img src="https://github.com/iignaite/Codemm/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0E2754" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-0E2754" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%28experimental%29-0E2754" alt="Platforms: macOS, Linux, Windows (experimental)">
</p>

## What is Codemm

Codemm is an open-source harness for learning to code by practice. Your own coding agent (Claude Code, Codex or Cursor, on your own plan) writes the courses and exercises; Codemm proves each exercise works, grades your code in a sandbox and tracks what you've mastered.

Codemm never calls a model and needs no API keys or accounts. It ships no languages: your agent sets up each language or framework the first time you need it, and Codemm checks that it works.

## How it works

1. **You say what you want to learn**, for example "Teach me pointers in C."
2. **Your agent installs a track**, the environment for that language: a Dockerfile, a `track.yaml` and small probe programs. Codemm installs it only after the probes pass with the network off.
3. **Your agent plans a roadmap**, a concept graph that Codemm checks for cycles and unknown concepts.
4. **Your agent writes an exercise**: a statement, starter code, a reference solution, 2–4 deliberately broken variants and visible and hidden tests. Codemm accepts it only if the reference passes, the starter fails and the tests catch every broken variant.
5. **You solve it in your editor** and run `codemm check`. Each check moves your mastery of the concept, and difficulty adapts as you go.

While you practice in Claude Code, a hook stops the agent from editing your exercise files, so it explains instead of solving. `codemm assist on` lifts the block, and those attempts count for less.

## Requirements

- Node.js 22 or newer
- Docker, running (Docker Desktop on macOS and Windows)
- Claude Code, Codex or Cursor

## Install

A downloadable app for macOS and Windows is coming in 1.0. Until then, install the CLI from source (it isn't on npm yet):

```bash
git clone https://github.com/iignaite/Codemm.git
```

```bash
cd Codemm && npm ci && npm run build && npm link
```

Then check that Docker and the sandbox work:

```bash
codemm doctor
```

## Quick start

In an empty project folder:

```bash
codemm init
```

This sets up Claude Code, Codex and Cursor; use `--host claude` (repeatable) to pick specific ones. It adds an MCP server entry for each agent, a Codemm section in `AGENTS.md`, an author subagent and the Claude Code practice hook. Existing config is merged, never replaced.

Open the folder in your agent and say what you want to learn.

> [!NOTE]
> Codex loads `.codex/config.toml` only for projects you've marked as trusted, and asks before each Codemm tool call. To skip those prompts, add `default_tools_approval_mode = "approve"` under `[mcp_servers.codemm]`; that also skips your approval for `save_track`, which runs a network build.

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
| `codemm track rebuild <id@version>` | Rebuild a track image and re-verify its exercises |

Your agent uses the MCP tools `list_tracks`, `save_track`, `save_roadmap`, `next_step`, `save_exercise`, `get_exercise`, `check` and `progress`.

## Supported agents and platforms

| | Verified | Experimental |
|---|---|---|
| **Agents** | Claude Code, Codex | Cursor |
| **Platforms** | macOS with Docker Desktop, Linux | Windows (Docker Desktop with WSL 2), Podman |

Verified means a real end-to-end run is recorded in the [1.0 release evidence](docs/release-evidence-1.0.md) or covered by CI. CI runs the unit tests on macOS, Linux and Windows, and the Docker tests on Linux. Windows stays experimental until it has a full run on a Windows machine.

## Good to know

- **Installing a track runs code your agent wrote, with network access**, like `npm install` in someone else's project. Approve `save_track` only for tracks you'd run yourself. Checks always run with the network off and with memory, CPU, process and time limits.
- **Grading is on the honor system.** Hidden tests are hidden from your agent's tools, not from you, and code in the sandbox could fake its own result. Codemm is built for self-learners, not graded classwork.
- **Codemm proves an exercise is consistent, not that its statement is right.** If something reads wrong, tell your agent.
- **Your data** (tracks, courses and attempt history) lives in `~/.codemm`; set `CODEMM_HOME` to move it. Your project folder holds `codemm.json` and `exercises/`.

## Documentation

- [Docs index](docs/README.md)
- [Design](docs/DESIGN.md): the spec, formats and gates
- [Security](docs/SECURITY.md): the sandbox, trust boundaries and known limits
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) first; Codemm stays small on purpose.

## License

[MIT](LICENSE)
