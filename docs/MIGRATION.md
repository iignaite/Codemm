# Migrating from Codemm v1

Codemm 1.0 replaces v1 (the Electron desktop app) with a small CLI and MCP server that your own coding agent drives. The two share no code and no data.

## What changed

| v1 | 1.0 |
|---|---|
| Electron + Next.js desktop app | `codemm` CLI and MCP server; your editor and agent are the UI |
| Called OpenAI, Anthropic, Gemini or Ollama with your API keys | Never calls a model; Claude Code, Codex or Cursor does the writing on your own plan |
| Built-in judges for Java, Python, C++ and SQL | Ships no languages; your agent installs any language or framework as a track |
| Single generated activities | A roadmap with prerequisites, adaptive difficulty and mastery |
| Reference solutions checked in Docker | Plus: the starter must fail, mutants must be caught, and the reference must be fast and deterministic |

## Your v1 data

**1.0 does not import v1 progress.** v1 concepts were free-text tags, and 1.0 concepts are roadmap ids, so nothing maps reliably. **1.0 never reads, moves or deletes v1 data.** It stays where v1 put it:

- **Activities, threads, submissions and mastery:** a SQLite database, `codemm.db`. v1 looked for its folder in this order:
  1. the `CODEMM_WORKSPACE_DATA_DIR` environment variable, if set;
  2. `<your workspace>/.codemm/`;
  3. if that wasn't writable, `<Electron userData>/Workspaces/<hash>/`.
- **Saved API keys:** `<Electron userData>/secrets.json`, encrypted with the operating system's keychain (Electron `safeStorage`). 1.0 doesn't need them; delete them when you no longer use v1.
- **Electron userData** is per app. On macOS it's under `~/Library/Application Support/`, for example `codemm-ide` for development builds or `Codemm-Desktop` for packaged ones.

1.0 keeps its own data in `~/.codemm/tracks` and `~/.codemm/courses`, and in `codemm.json` and `exercises/` inside a workspace. None of these collide with v1's files, so both can sit side by side.

## Running v1 again (rollback)

v1 stays in git history at commit `5e3f3a7`, the last v1 commit on `main`. To run it next to 1.0, use a separate checkout:

```bash
git clone https://github.com/iignaite/Codemm.git codemm-v1
cd codemm-v1
git checkout 5e3f3a7
npm ci
npm run dev
```

Open your old workspace folder when v1 asks, and your v1 data is there. These steps were verified for the 1.0 release: `npm ci`, `npm run build` and the v1 unit suite pass at `5e3f3a7`.

To roll back the repository itself, revert the 1.0 merge commit on `main`.
