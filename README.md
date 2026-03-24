<div align="center">
  <h1>Codemm</h1>
  <p>Codemm is an AI agent that turns a short chat into verified programming activities (problems + tests) and grades solutions in Docker sandboxes.</p>
  <img src="./apps/frontend/images/Codemm-home.png" alt="Codemm home" width="900" />
</div>

## What Codemm-Desktop Is (Desktop-First)

Codemm runs entirely on your machine:

- No authentication, accounts, profiles, or community features.
- A **workspace** (folder on disk) owns all durable state.
- A **thread** is a local conversation that produces an `ActivitySpec`.
- A **run** is an append-only execution log (generation / judge), used for replay + debugging.
- Generation runs now include slot-attempt diagnostics (failure kind, remediation hints, repair steps, token/finish metadata when providers expose it).
- An **activity** is the output you practice: learner-facing problems + tests, verified in Docker.

Design goals:

- Determinism at boundaries (LLM proposes; deterministic code validates/gates/persists).
- Debuggability (durable run logs and reproducible state).
- Safety (untrusted code runs in Docker only).

## High-Level Architecture

Processes (today):

- **Electron main** (`apps/ide/main.js`): boot orchestration, workspace selection, secrets handling, IPC bridge.
- **Local engine** (`apps/backend`): agent loop + SQLite persistence + Docker judge. Exposes RPC via Node IPC (`process.send`).
- **Renderer UI** (`apps/frontend`): Next.js UI loaded inside Electron; uses `window.codemm.*` via a preload allowlist (`apps/ide/preload.js`).

There is no internal HTTP API for engine calls. UI → engine is IPC only.

## Local State & Persistence

- Per-workspace DB: `<workspaceDataDir>/codemm.db` (preferred: `<workspace>/.codemm/codemm.db`)
- Key tables (IDE-first): `threads`, `thread_messages`, `activities`, `runs`, `run_events`

## Security Model (Practical)

- **Docker is the sandbox boundary** for untrusted code execution/judging.
- Electron hardening:
  - `nodeIntegration: false`, `contextIsolation: true`
  - strict preload allowlist (`window.codemm.*`) with payload validation
- Secrets:
  - stored locally via Electron `safeStorage` (encrypted at rest)
  - never returned to renderer JS
  - engine is configured in-memory on boot via IPC (API keys are not passed via environment variables)
- Renderer loading:
  - UI is served from localhost (transitional) and verified via `GET /codemm/health` + an ephemeral boot token before the Electron window loads it (mitigates localhost port hijacking).

## No API Key? Use Ollama (Local Model)

If you can’t use a paid API key, Codemm can use a local model via Ollama:

1) Install Ollama (it runs on `http://127.0.0.1:11434`).
2) In Codemm → **LLM Settings**:
   - Provider: `Ollama (local)`
   - Model: e.g. `qwen2.5-coder:7b`
3) Click **Ensure + pull model** to start Ollama (best-effort) and pull the model from inside the app.

## Development

Requirements:

- macOS / Windows / Linux
- Node.js + npm
- Docker Desktop (running)

Run:

```bash
npm install
npm run dev
```

On first launch, pick a workspace folder. Configure your provider via **LLM Settings** in the UI.

Dev default: when running from the repo, if `CODEMM_WORKSPACE_DIR` is not set, Codemm defaults the workspace to the repo root so the local `.codemm/` folder is created inside the repo (and is gitignored).

## Packaging

```bash
npm install
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Builds are typically produced on the target OS (mac builds on macOS, win builds on Windows, etc). All `dist:*` scripts rebuild native deps for Electron automatically (notably `better-sqlite3`).

## Docs Index

- IDE-first mental model + topology: `docs/architecture/IDE_FIRST.md`
- Migration phases: `docs/architecture/MIGRATION.md`
- Wrapper behavior: `docs/FUNCTIONS.md`
- Security notes: `docs/SECURITY.md`
- Troubleshooting: `docs/TROUBLESHOOTING.md`
- Contributing: `CONTRIBUTING.md`

## Environment Overrides (Dev)

- `CODEMM_FRONTEND_PORT` (default `3000`)
- `CODEMM_FRONTEND_MODE=standalone` (use built Next standalone server in dev)
- `CODEMM_ENGINE_USE_DIST=1` (force engine `dist/*` instead of `ts-node`)
- `DOCKER_PATH` (explicit docker binary path)
- `CODEMM_WORKSPACE_DIR` (skip workspace picker)
- `CODEMM_WORKSPACE_DATA_DIR` (override workspace data dir; relative paths resolve from `CODEMM_WORKSPACE_DIR`)
- `CODEMM_DB_PATH` (override DB file path)
