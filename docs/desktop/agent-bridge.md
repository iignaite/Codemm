# Agent bridge spike: findings

Question: can the desktop app start the learner's own agent CLI headless with Codemm's MCP server, stream its replies as events, see Codemm tool calls, cancel it, and detect sign-in without touching credentials?

**Answer:** yes for Claude Code and Codex. Cursor is unverified because it isn't signed in on this machine.

The code is in [`spikes/agent-bridge/`](../../spikes/agent-bridge/):

- `agents.mjs` holds the per-agent launch arguments, stream parsers and sign-in checks.
- `bridge.mjs` handles spawn, line streaming, cancellation and sign-in.
- `spike.mjs` drives real runs.
- `evidence/` holds the event logs from the runs below.
- 15 unit tests run on recorded fixtures and fake agents: `node --test spikes/agent-bridge/*.test.mjs`.

## Setup

- Date: 17 Oct 2026, on macOS 15 (Darwin 24.6) with Node 22.18.
- Codemm was built from `main`, and the server was `node dist/cli.js mcp --workspace <temp>` with a temp `CODEMM_HOME`.
- Every run unset `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `CURSOR_API_KEY`, and used the owner's subscriptions. Claude Code reported `apiKeySource: "none"`.
- Small models kept the runs cheap and cover the weak end:
  - Claude Code with `--model haiku`, which resolved to `claude-haiku-4-5-20251001`;
  - Codex with `-m gpt-6-luna` at low reasoning effort.

| Agent | Version | Signed in |
|---|---|---|
| Claude Code | 2.1.283 | yes (claude.ai) |
| Codex | codex-cli 0.156.1 | yes (ChatGPT) |
| Cursor | cursor-agent 2026.01.23-916f423 | no |

## Results

| Check | Claude Code | Codex | Cursor |
|---|---|---|---|
| Headless start with the Codemm MCP server | yes: `--mcp-config <json string> --strict-mcp-config`; init reports `codemm` as `connected` | yes: `-c mcp_servers.codemm.*` overrides | not run: no `--mcp-config` flag; it reads `<ws>/.cursor/mcp.json` and needs the server approved |
| Stream parsed into events | yes (`claude-1.jsonl`) | yes (`codex-1.jsonl`) | not verified |
| Codemm tool calls | `list_tracks` succeeded; `progress` gave the expected "no course" error and was reported as an error | same | not verified |
| Follow-up turn (resume) | yes, `--resume <session_id>` in the same folder | yes, `codex exec resume <thread_id>` in the same folder | not verified |
| Cancellation | process group killed, exit 143, no leftover processes | process group killed, exit 0, no leftover processes | not verified |
| Read-only turn blocks writes | `Write` and `Bash` denied; no file created | sandbox refused; no file created | not verified |
| Sign-in detection | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in using ChatGPT" | `cursor-agent status` prints "Not logged in" with exit 0. A headless run exits 1 with "Authentication required". |

Timings (one run each, so indicative only):

| Run | Claude Code | Codex |
|---|---|---|
| Session started | 4.5 to 26 s | 0.5 to 7 s |
| Turn done, 2 tool calls | 16 s | 31 s |
| Resume turn done | 36 s | 13 s |

## Findings that shape the design

1. **Close stdin.** Claude Code waits 3 s for stdin and Codex reads stdin when it isn't a terminal. The bridge spawns with stdin ignored.
2. **Cancel the process group, not the process.** The agent starts the Codemm MCP server as a child. Spawning detached and killing `-pid` stopped both, and no processes were left over. Windows needs `taskkill /t /f` (not run here).
3. **Streaming is per message.** Codex emits whole `agent_message` items, and Claude Code emits whole assistant messages unless `--include-partial-messages` is set. The panel shows a working state between messages.
4. **Startup varies (0.5 to 26 s).** User-level hooks and settings still load: the owner's Claude Code ran six global hooks before init. The app must show a working state at once and never assume a fast start.
5. **Claude Code loads MCP tools lazily.** Before each first call, a `ToolSearch` step loads the Codemm tool's schema. Both small models handled it, but it is one more step for weak models, which argues for exposing only each job's tools.
6. **The agent's own config can break headless runs.** The owner's Codex default model (`gpt-6.1-sol`) was rejected for a ChatGPT sign-in (`turn.failed`, fixture `codex-model-rejected.jsonl`). The app must show this as "Codemm couldn't finish that" with a way to the connect screen. Open decision O6 covers whether to add a model setting.
7. **Read-only depends on flags, not defaults.** Claude Code denied `Write` only because no permission handler runs in `-p` mode and the owner's settings don't allow it. A learner's settings could allow it, so tutor turns must pass `--permission-mode default` and `--disallowedTools`. For Codex, `-c sandbox_mode="read-only"` overrides the config.
8. **Approving every Codex tool is safe only in desktop mode.** `default_tools_approval_mode="approve"` lets every Codemm tool run without a prompt. That is safe only because `save_track` in desktop mode proposes instead of building (DESIGN §4.1).
9. **Sign-in needs no credential access.** Each agent's own status command answers it. `claude auth status` also prints the email and organization, so the bridge keeps only the boolean and drops the output.
10. **Cost.** A trivial Codex turn used about 66k input tokens (44k cached), mostly the agent's own system prompt and user config. Fresh, short jobs are still cheaper than long resumed sessions, but every job has a fixed floor.
11. **GUI discovery.** `codex` here lives in a per-shell fnm folder (`~/.local/state/fnm_multishells/...`) that a GUI app won't find. Hence the "choose the executable" fallback on the connect screen.

## Cursor: what is known, unverified

- Headless mode: `cursor-agent -p --output-format stream-json`, `--approve-mcps` for MCP servers, `--mode ask` for read-only, `--resume [chatId]`, `--workspace <path>`.
- MCP servers come only from `.cursor/mcp.json` (project or home), so the app must write `<ws>/.cursor/mcp.json`. `cursor-agent mcp list-tools codemm` refused with "has not been approved".
- The spike didn't run `cursor-agent mcp enable`, because it changes the owner's Cursor settings.
- To verify: sign in, then run the same five checks and record a fixture for the parser (DESIGN D16).
