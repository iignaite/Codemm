# Troubleshooting (Codemm-Desktop)

## Docker Not Found

Symptom:

- Dialog shows “Docker Not Found”.

Fix:

- Install Docker Desktop.
- Ensure `docker` is on your PATH.
- Or set `DOCKER_PATH` to your docker binary (common locations):
  - `/opt/homebrew/bin/docker`
  - `/usr/local/bin/docker`
  - `/Applications/Docker.app/Contents/Resources/bin/docker`

## Docker Not Running

Symptom:

- Dialog shows “Docker Not Running”.

Fix:

- Start Docker Desktop and wait until it finishes starting.
- Relaunch `Codemm-Desktop`.

## Port Already In Use (3000)

Symptom:

- Frontend/backend fails to start.
- Terminal logs show address in use errors.

Fix:

- Start the app with different ports:
  - `CODEMM_FRONTEND_PORT=3010 npm run dev`

## Frontend Fails With Missing Dependencies

Symptom:

- Frontend process exits; logs show module not found.

Fix:

- From the repo root: run `npm install`.
- Then relaunch: `npm run dev`.

## Backend Fails Building Judge Images

Symptom:

- Backend logs show Docker build errors when starting.

Fix:

- Confirm Docker Desktop has enough resources (CPU/RAM).
- Try rebuilding images:
  - From repo root: `CODEMM_REBUILD_JUDGE=1 npm run dev`

## App Hangs On “Starting…”

Symptom:

- The window stays on the loading screen.

Fix:

- Check terminal logs for `[engine]` and `[frontend]`.
- Confirm the frontend URL works in a browser:
  - `http://127.0.0.1:3000/`

## No Workspace Selected

Symptom:

- Dialog shows “No Workspace Selected” on launch.

Fix:

- Relaunch and select a workspace folder when prompted.
- Or set `CODEMM_WORKSPACE_DIR` to a folder path before launching.

## Backend SQLite Error: SQLITE_CANTOPEN (“unable to open database file”)

Symptom:

- Backend logs show `SqliteError: unable to open database file`.

Fix:

- Ensure the SQLite DB lives in a writable location.
  - By default, Codemm-Desktop uses a per-workspace DB at `<workspaceDataDir>/codemm.db`.
  - Preferred workspace data dir: `<workspace>/.codemm/`.
  - Fallback workspace data dir: Electron `userData/Workspaces/<hash>/`.
  - If you override `CODEMM_DB_PATH`, prefer an absolute path (or `~`).

## Backend SQLite Error: `SqliteError: near \")\": syntax error`

Symptom:

- Backend logs show a schema init error like `SqliteError: near ")": syntax error`.

Fix:

- Ensure you are on the latest repo commit (this was caused by a schema typo during migration work).
- If the DB file was created during a failed init, delete the workspace DB and relaunch:
  - Default workspace DB path: `<workspace>/.codemm/codemm.db`

## Native Module ABI Mismatch (better-sqlite3)

Symptom:

- Backend logs show an Electron/native module error like:
  - `better_sqlite3.node was compiled against a different Node.js version` or `NODE_MODULE_VERSION ...`

Why it happens:

- `better-sqlite3` is a native module and must be built against Electron’s Node ABI for packaged runs.

Fix (packaging / dist):

- From repo root:
  - `npm run dist:mac`
  - `npm run dist:win`
  - `npm run dist:linux`

Fix (dev):

- If you want the engine to run under your system Node instead of Electron’s Node (avoids ABI mismatch):
  - `CODEMM_NODE_BIN=node npm run dev`

## Ollama Not Running / Model Not Found

Symptom:

- Generation fails with an Ollama error (connection refused / model not configured / model not found).

Fix:

- Install Ollama (local server).
- In **LLM Settings**: Provider `Ollama (local)` → set Model (example: `qwen2.5-coder:7b`) → click **Ensure + pull model**.

## Electron/Chromium Cache Error: “Failed to write the temporary index file”

Symptom:

- Electron logs show `simple_index_file.cc(322) Failed to write the temporary index file`.

Fix:

- Ensure Electron’s storage directories are writable.
  - You can override paths with: `CODEMM_USER_DATA_DIR`, `CODEMM_CACHE_DIR`, `CODEMM_LOGS_DIR`.

## Generation Fails On Complex Slots

Symptom:

- Generation stops with a generic failure after retries.
- Progress UI shows slot failures (contract / docker / timeout).

Fix:

- Retry only the failing slot (V2 flow) instead of regenerating the entire thread:
  - `threads.regenerateSlot({ threadId, slotIndex, strategy })`
- Inspect persisted diagnostics for the latest run:
  - `threads.getGenerationDiagnostics({ threadId })`
- If diagnostics indicate truncation or weak model capability:
  - use a stronger model in **LLM Settings**
  - reduce slot complexity (fewer constraints / narrower topics) and retry
