# Contributing (Codemm-Desktop)

Codemm-Desktop is an Electron wrapper around the in-repo apps:

- `apps/backend` (local engine: agent loop + SQLite + Docker judge; IPC-only)
- `apps/frontend` (Next.js renderer UI)

The goal is a single desktop app experience while keeping backend determinism and Docker-based judging intact.

## Repo Layout

- `apps/ide/main.js` Electron main process (starts backend + frontend, then opens a window)
- `apps/ide/localLlm/*` local-runtime orchestration (install/start/pull/probe/lease)
- `package.json` npm workspaces root + scripts
- `apps/ide/package.json` Electron dev entrypoint
- `docs/` project docs (functions, troubleshooting, handoffs)

## Local Development

1. Ensure Docker Desktop is running.
2. From the repo root:

```bash
npm install
npm run dev
```

Note: this is an npm workspaces monorepo. Use the repo root for installs; do not maintain per-app lockfiles.

This will:

- start the local engine from `apps/backend` (IPC; no internal HTTP server)
- start frontend from `apps/frontend`
- open the local frontend URL inside Electron (served from localhost as a transitional layer)

## Making Changes

- Desktop wrapper logic: edit `main.js`
- Local-runtime orchestration: edit files in `apps/ide/localLlm`
- Backend behavior/API/judge: edit files in `apps/backend`
- UI/UX: edit files in `apps/frontend`

Keep in mind:

- Codemm’s “agent logic” is backend-owned; the IDE should remain a thin shell over backend contracts.
- Judging relies on Docker; don’t add a path that executes untrusted code outside Docker.
- For generation APIs, preserve IPC naming stability (`threads.generate`, `threads.generateV2`, `threads.regenerateSlot`, `threads.getGenerationDiagnostics`).
- Generation progress is `runId`-scoped. Do not add thread-wide progress reducers or subscriptions that can mix overlapping runs.
- Persistent generation state lives in `generation_runs`, `generation_slot_runs`, and `generation_slot_transitions`. Avoid rebuilding run state from transient UI reducers or `problems_json` length.

## Style / Guardrails

- Keep `nodeIntegration: false` and `contextIsolation: true` in Electron.
- Prefer explicit timeouts and clear error dialogs when booting dependencies.
- Avoid hard-coding absolute paths; use environment overrides (`CODEMM_BACKEND_DIR`, `CODEMM_FRONTEND_DIR`) where needed.
