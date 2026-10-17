# Security

Codemm runs code that an AI agent wrote and code that a learner wrote. This page says what Codemm protects, how, and where it stops.

## What Codemm protects

**Your machine.** Agent-written and learner code runs only in containers, started by one function (`src/sandbox.ts`) with the same isolation every time:

| Setting | Why |
|---|---|
| `--network none` | No network access while checking |
| `--read-only`, plus a 256 MB `/tmp` tmpfs (`nosuid`, `nodev`) | Nothing else in the container is writable |
| Inputs bind-mounted read-only | Code can't change the files it's graded on |
| `--memory` (equal swap, at most 2 GB), `--cpus 2`, `--pids-limit 256` | Memory balloons, CPU hogs and fork bombs stay contained |
| `--security-opt no-new-privileges`, `--cap-drop ALL`, your own uid | No root and no Linux capabilities |
| `--entrypoint /bin/sh`, `--no-healthcheck` | The image can't hijack how Codemm runs it |
| `--log-opt max-size=1m`, a 4 MB stream cap, 64 KB per case | Output can't fill your disk or memory |
| `timeout -s KILL` per case, a host deadline per set, labelled containers | Hung code is killed and cleaned up |

`codemm doctor` proves the network is blocked. It first checks that an ordinary container can reach a test server on your machine, then that the sandbox can't.

**Hidden tests from your agent's tools.** Hidden inputs, expected outputs and test names never appear in tool output, CLI output or gate diagnostics. Hidden results show an index and a status only, and visible tests run in a separate container that can't read hidden ones.

**Your files.** Author input is limited to 256 files and 1 MB, with relative paths only and no symlinks, FIFOs or devices. Codemm writes its own data atomically. In your workspace it only creates missing files, never overwrites your edits, and refuses to write through symlinks.

## Trust boundaries

- **Installing a track runs agent-written code with network access.** That's the Dockerfile build, much like running `npm install` from someone else's project.
  - **The trust point** is you approving the `save_track` call in your agent, or running `codemm track add` yourself. `codemm init` never pre-approves it.
  - **The build** gets only the track's own files: no secrets, SSH agent or Docker socket.
  - **Time limit:** 10 minutes.
  - **Not limited:** build CPU, memory and disk use.
- **Codemm never handles credentials.** It doesn't call models; your agent does, on your own plan.

## Known limitations

- **Grading is on the honor system.** Code inside the sandbox runs as the same user as Codemm's driver script, so it can read the tests mounted for its own set and could write forged result frames. This doesn't weaken host isolation. Tamper-proof grading would need a separate trusted grader; Codemm 1.0 is for self-learners.
- **The practice hook is advisory.** It blocks Claude Code's edit tools only, not edits made through shell commands, and Codex and Cursor have no hook yet.
- **Symlink race.** Node has no directory-anchored, no-follow traversal. Codemm checks ancestors with `realpath` and writes with `O_NOFOLLOW` and `O_EXCL`. A local process that swaps a parent folder for a symlink in the instant between check and write could redirect one write, but it already has your permissions.
- **Build resource use isn't limited** (see above).

## Reporting a problem

Please report security issues privately to the maintainers of `iignaite/Codemm` rather than in a public issue.
