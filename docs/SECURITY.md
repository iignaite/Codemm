# Security Notes (Codemm-Desktop)

## Threat Model (Practical)

- Renderer is untrusted content relative to the OS.
- Codemm runs/grades untrusted user code; **Docker is the sandbox boundary**.
- The Electron app must not become a path to local code execution outside Docker.

## Electron Hardening Checklist

- BrowserWindow:
  - `nodeIntegration: false`
  - `contextIsolation: true`
  - no `remote` module
- Navigation control:
  - only load the local frontend URL
  - block unexpected navigations/new windows
  - mitigate localhost port hijacking by verifying the frontend health token before loading
- IPC:
  - use `preload` with minimal surface area
  - validate all inputs
  - do not expose filesystem/network primitives directly to the renderer

## Secrets

- Avoid storing provider API keys in the renderer.
- Current: Electron main stores keys locally using `safeStorage` and exposes only a minimal preload bridge.
- Target: OS keychain integration (macOS Keychain) with per-workspace overrides.

Local model option:

- Ollama runs on localhost and requires no API key, but it is still a local network boundary.
- Codemm only calls the Ollama endpoint from the engine process (renderer does not receive model credentials).

## Docker Boundary

- All compilation/execution/judging remains in Docker.
- The app should never run submitted code directly via `child_process` outside Docker.
- Docker is invoked via `spawn()` with argument arrays (no shell command strings) to reduce injection surface and improve cross-platform behavior.

Sandbox flags (injected for every container at the single `runDocker` choke point — see `apps/backend/src/judge/docker.ts`):

- `--network none` and a read-only root filesystem, with scratch confined to a size-capped `mode=1777` tmpfs.
- Resource limits: `--pids-limit 256`, `--memory 1g` (swap capped equal), `--cpus 2` — verified to contain a fork bomb on a live judge.
- `--security-opt no-new-privileges` everywhere.
- On POSIX hosts, untrusted code runs as the invoking user (`--user uid:gid`) with **every Linux capability dropped** (`--cap-drop ALL`); matching the host uid keeps the 0700 bind-mounted workspaces readable and Java's read-write compile mount writable. Windows has no uid mapping, so containers there keep the image default user plus the flags above.
- Wall-clock timeouts and output-size kills apply on top (`spawnCapture`).

## Localhost Port Hijacking (Transitional)

Codemm-Desktop currently serves the renderer UI from a local Next.js server (127.0.0.1).

Threat:

- If the IDE loads an unexpected page (wrong port, hijacked port, unrelated local service), that page would still be running inside the Electron renderer and could call the preload bridge.

Mitigation (current):

- Electron main verifies it is talking to the frontend server it started by polling `GET /codemm/health` and checking an ephemeral token set via `CODEMM_FRONTEND_TOKEN`.

Target (final):

- Remove localhost serving entirely (embed assets via custom protocol / file-based loading).
