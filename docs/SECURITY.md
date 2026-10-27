# Security

Codemm runs code that an AI agent wrote and code that a learner wrote. This page says what Codemm protects, how, and where it stops.

## What Codemm protects

**Your machine.** Agent-written and learner code runs only in a sandbox: in containers, started by one function (`src/sandbox.ts`) with the same isolation every time, or, for a WASI track, in wasmtime (`src/wasi.ts`, below).

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

`codemm doctor` proves the network is blocked. It first checks that an ordinary container can reach a test server on your machine, then that the sandbox can't. If the first step fails, it reports the check as inconclusive (a failure), not as passed.

**The WASI engine (no Docker).** A WASI track runs a WebAssembly build of its language's interpreter in [wasmtime](https://wasmtime.dev), as your own user, with no VM and no admin rights ([DESIGN §4.5](DESIGN.md#45-the-wasi-engine-no-docker)). wasmtime is the sandbox: the program's memory is isolated, and it can open only the folders it is given.

| Setting | Why |
|---|---|
| Only the toolchain's folders and the learner's files are mapped, and both are sealed read-only first (files 0444, folders 0555; on Windows also a deny entry) | The program can't write anywhere: the operating system refuses, and a seal that fails stops the check |
| Tests are never mapped; the host writes each input to stdin | Code can't read any test file |
| `-S inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n` | No network access |
| Only the track's `env` inside the sandbox, and wasmtime itself starts with an empty environment | Your environment variables, and any wasmtime setting, stay out |
| `-W max-memory-size`, `-W timeout` and a host kill one second later | Memory balloons and hung code stay contained |
| stdout and stderr capped together per case, stderr kept to 4 KB | Output can't fill your disk or memory |
| The host writes every result frame | The program can't forge a result frame |

WASI has no processes, so there's nothing to fork. `codemm doctor` runs a small module that must fail to create a file in a sealed folder. The toolchain is downloaded over https (every redirect too) only when you consent, and sealed read-only. When the track gives a SHA-256, the download must match it; when it doesn't, Codemm records the digest it downloaded, and later rebuilds must match that.

**Hidden tests from your agent's tools.** Hidden inputs, expected outputs and test names never appear in tool output, CLI output or gate diagnostics. Hidden results show an index and a status only, and visible tests run in a separate container that can't read hidden ones.

**Your files.** Author input is limited to 256 files and 1 MB, with relative paths only and no symlinks, FIFOs or devices. Codemm writes its own data atomically. In your workspace it only creates missing files, never overwrites your edits, and refuses to write through symlinks.

## Trust boundaries

- **Installing a track runs agent-written code with network access.** That's the Dockerfile build, much like running `npm install` from someone else's project.
  - **The trust point** is you approving the `save_track` call in your agent, or running `codemm track add` yourself. `codemm init` never pre-approves it.
  - **The build** gets only the track's own files: no secrets, SSH agent or Docker socket.
  - **Time limit:** 10 minutes.
  - **Not limited:** build CPU, memory and disk use.
  - **A WASI track builds nothing.** Installing it downloads the file its `track.yaml` names, over https, unpacks it with the system's own `tar`, and compiles it once with wasmtime. The agent's code runs only in wasmtime.
- **Codemm never handles credentials.** It doesn't call models; your agent does, with your own account.

## Known limitations

- **Grading is on the honor system.** In a container, code runs as the same user as Codemm's driver script, so it can read the tests mounted for its own set and could write forged result frames; the WASI engine maps no tests and writes the frames itself. Either way, hidden tests sit in Codemm's files on your computer. This doesn't weaken host isolation. Tamper-proof grading would need a separate trusted grader; Codemm 1.0 is for self-learners.
- **The practice hook is advisory.** It blocks Claude Code's edit tools only, not edits made through shell commands, and Codex and Cursor have no hook yet.
- **Symlink race.** Node has no directory-anchored, no-follow traversal. Codemm checks ancestors with `realpath` and writes with `O_NOFOLLOW` and `O_EXCL`. A local process that swaps a parent folder for a symlink in the instant between check and write could redirect one write, but it already has your permissions.
- **Build resource use isn't limited** (see above). Neither is a WASI toolchain's unpacked size; Codemm checks that 1.5 GB is free first.
- **WASI: CPU and file times.** CPU isn't limited, but a WASI module runs on one thread. On macOS and Linux the program can set a read-only file's times, a tiny channel between runs that is accepted.

## Reporting a problem

Please report security issues privately to the maintainers of `iignaite/Codemm` rather than in a public issue.
