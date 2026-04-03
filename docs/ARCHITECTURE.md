# Architecture (Codemm-Desktop)

Codemm-Desktop is a local-only Electron desktop app.

Core docs:

- IDE-first model + state ownership: `docs/architecture/IDE_FIRST.md`
- Local LLM control plane: `docs/architecture/LOCAL_LLM_ORCHESTRATION.md`
- Migration phases + transitional layers: `docs/architecture/MIGRATION.md`

## Processes

- Electron main process: `apps/ide/main.js`
- Local engine child process: `apps/backend` (agent loop + Docker judge + SQLite) via IPC (`apps/backend/ipc-server.js`)
- Frontend child process (transitional): `apps/frontend` (Next.js UI)

## Boot Sequence

1. Check Docker (`docker info`).
2. Select a workspace folder (prompt on first run; persisted).
3. Ensure npm dependencies are installed in the repo root (`npm install` if `node_modules/` is missing).
4. Ensure judge images exist (build `apps/backend/Dockerfile.*-judge` as needed).
5. Start engine via IPC (`fork` → `apps/backend/ipc-server.js`) with:
   - `CODEMM_DB_PATH=<workspaceDataDir>/codemm.db`
   - run-scoped LLM snapshots sent over IPC for LLM-backed calls
6. Start frontend on `CODEMM_FRONTEND_PORT` (default 3000).
7. Load the frontend URL inside Electron with a preload bridge (`apps/ide/preload.js`).

## Packaging Target (Next)

Replace “child process calling `npm run dev`” with production builds embedded in the app bundle:

- Backend: compiled `dist/` + bundled `node_modules` rebuilt for Electron.
- Frontend: Next production output (Phase 3: `output: "standalone"` with `.next/standalone/server.js`).
- IDE: embed frontend build and eliminate the Next dev server.

Native modules:
- Packaged Electron builds must rebuild native deps (notably `better-sqlite3`) against Electron’s ABI (`npm run rebuild:electron`).
