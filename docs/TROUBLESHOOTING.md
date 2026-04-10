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

## Local Model Activation Fails

Symptom:

- `Use Local Model` stays in a failed state.
- Local runtime status shows `Failed` or `Needs recovery`.

Fix:

- Open **LLM Settings** and inspect the local runtime status card.
- Retry **Use Local Model**. Codemm will re-run install/start/pull/probe automatically.
- If the error persists:
  - ensure the machine has enough free RAM and disk for the selected profile
  - ensure the network allows downloading Ollama and model artifacts
  - inspect the latest status message and error code shown in the UI
  - if needed, remove the cached runtime state under Electron `userData` and retry

Common failure classes:

- `INSTALL_FAILED`
- `SERVER_START_FAILED`
- `MODEL_PULL_FAILED`
- `PROBE_FAILED`

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
  - `threads.regenerateSlot({ threadId, slotIndex, strategy: "retry_full_slot" })`
- Inspect persisted diagnostics for the latest run:
  - `threads.getGenerationDiagnostics({ threadId })`
- If diagnostics indicate truncation or weak model capability:
  - use a stronger model in **LLM Settings**
  - reduce slot complexity (fewer constraints / narrower topics) and retry

Notes:

- Generation no longer treats the first failed slot as a thread-wide hard stop. Partial success is persisted when at least one slot succeeds.
- Older regeneration strategies such as `repair_reference_solution` are intentionally rejected until stage-targeted slot resume is implemented in the persistent state machine.

## Generation Stops Immediately With A Weak Local Route Warning

Symptom:

- The UI warns that the selected local route is weak.
- Hard or multi-topic generation fails before Docker validation starts.

Fix:

- Open **LLM Settings**.
- Switch the local routing profile from `Fast local` to `Balanced local` or `Strong local`.
- Or use **Custom per-role** and raise at least the `tests`, `reference`, and `repair` models.
- If you want the weak profile, reduce the request:
  - avoid `hard`
  - use one topic
  - avoid workspace-heavy prompts

## Run Details Show A Stage Failure

Symptom:

- The home screen `Run Details` panel shows failures in `skeleton`, `tests`, `reference`, `validate`, or `repair`.

Fix:

- `skeleton` / `tests`: the model route is usually too weak or the prompt is too broad.
- `reference`: switch to a stronger route or retry after narrowing the slot topic.
- `validate`: inspect the terminal failure message and Docker exit metadata in the diagnostics panel.
- `repair`: the first reference artifact failed and the one-step repair did not recover; retry the slot or strengthen the `repair` route.

## Thread Appears Stuck In `GENERATING` After A Crash

Symptom:

- The app closes during generation.
- On restart, the thread still appears to be `GENERATING` or `GENERATE_PENDING`.

Fix:

- Restart the desktop app fully. The backend now reconciles stale `generation_runs` on startup and rewrites orphaned thread state from persisted run/slot records.
- If the latest run was interrupted mid-slot, the recovered run is marked `RETRYABLE_FAILURE` or `INCOMPLETE` instead of remaining permanently `RUNNING`.

## Reference Solution Times Out During Validation

Symptom:

- Diagnostics show `validate` failure or `Reference solution timed out`.

Fix:

- Inspect the latest generation diagnostics and note whether the judge classified the failure as:
  - `TIME_BUDGET_EXCEEDED`
  - `OUTPUT_LIMIT_EXCEEDED`
  - `COMPILE_FAILURE`
  - `TEST_FAILURE`
  - `JUDGE_INFRA_FAILURE`
- If the failure is `TIME_BUDGET_EXCEEDED`, reduce slot complexity or strengthen the `reference` / `repair` model route.
- If the failure is `OUTPUT_LIMIT_EXCEEDED`, inspect the generated reference or tests for runaway logging.
- If the failure is `JUDGE_INFRA_FAILURE`, verify Docker Desktop is healthy and the judge image is present.

## Activity Is Marked `INCOMPLETE`

Symptom:

- Generation produced only some of the requested problems.
- Review mode shows an `INCOMPLETE` badge and publishing is disabled.

Fix:

- Open the activity review screen and use `Repair failed slots`.
- Codemm now reruns only the failed or interrupted slot indexes and preserves the successful problems already attached to the activity.
- If the repair succeeds for every remaining slot, the activity returns to editable `DRAFT` status and can be published normally.
