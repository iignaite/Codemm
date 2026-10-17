# Agent bridge spike: findings

Question: can the desktop app start the learner's own agent CLI headless with Codemm's MCP server, stream its replies as events, see Codemm tool calls, cancel it, and detect sign-in without touching credentials?

**Answer:** yes for Claude Code and Codex. Cursor is unverified because it isn't signed in on this machine.

The code is in [`spikes/agent-bridge/`](../../spikes/agent-bridge/):

- `agents.mjs` holds the per-agent launch arguments, stream parsers and sign-in checks.
- `bridge.mjs` handles spawn, line streaming, cancellation and sign-in.
- `spike.mjs` drives real runs.
- `evidence/` holds the event logs from the runs below.
- 17 unit tests run on recorded fixtures and fake agents: `node --test spikes/agent-bridge/*.test.mjs`.

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
| Headless start with the Codemm MCP server | yes: `--mcp-config <json string> --strict-mcp-config --tools ""`; init reports `codemm` as `connected` | yes: `-c mcp_servers.codemm.*` overrides, with only the job's tools in `enabled_tools` | not run: no `--mcp-config` flag; it reads `<ws>/.cursor/mcp.json` and needs the server approved |
| Stream parsed into events | yes (`claude-1.jsonl`) | yes (`codex-1.jsonl`) | not verified |
| Codemm tool calls | `list_tracks` succeeded; `progress` gave the expected "no course" error and was reported as an error | same | not verified |
| Follow-up turn (resume) | yes, `--resume <session_id>` in the same folder | yes, `codex exec resume <thread_id>` in the same folder | not verified |
| Cancellation | process group killed, exit 143, no leftover processes | process group killed, exit 0, no leftover processes | not verified |
| Isolation (canary file outside the workspace) | only Codemm tools exist; canary not read (`claude-isolation.jsonl`) | writes and shell off, canary not read, but host tools remain (`codex-isolation.jsonl`) | not verified |
| Sign-in detection | `claude auth status --json`, field `loggedIn` | `codex login status`, exit 0 and "Logged in using ChatGPT" | `cursor-agent status` prints "Not logged in" with exit 0. A headless run exits 1 with "Authentication required". |

Timings come from the final runs in `evidence/`, one run each, so they are indicative only:

| Run | Claude Code | Codex |
|---|---|---|
| Session started | 6 to 11 s (up to 26 s before `--tools ""`) | 2.7 to 7 s |
| Turn done, 2 tool calls | 22 s | 43 s |
| Resume turn done | 15 s | 13 s |

## Findings that shape the design

1. **Close stdin.** Claude Code waits 3 s for stdin and Codex reads stdin when it isn't a terminal. The bridge spawns with stdin ignored.
2. **Cancel the process group, not the process.** The agent starts the Codemm MCP server as a child. Spawning detached and killing `-pid` stopped both, and no processes were left over. `run()` resolves only once the group is gone. It sends SIGKILL to a child that ignores SIGTERM (unit test), and a job cancelled before it starts never spawns. Windows needs `taskkill /t /f` (not run here).
3. **Streaming is per message.** Codex emits whole `agent_message` items, and Claude Code emits whole assistant messages unless `--include-partial-messages` is set. The panel shows a working state between messages.
4. **Startup varies (0.5 to 26 s).** User-level hooks and settings still load: the owner's Claude Code ran six global hooks before init. The app must show a working state at once and never assume a fast start.
5. **Claude Code loads MCP tools lazily, unless built-in tools are off.** With default tools, a `ToolSearch` step loaded the Codemm tool's schema before each first call. With `--tools ""` the Codemm tools load directly and the step disappears, which helps weak models.
6. **The agent's own config can break headless runs.** The owner's Codex default model (`gpt-6.1-sol`) was rejected for a ChatGPT sign-in (`turn.failed`, fixture `codex-model-rejected.jsonl`). The app must show this as "Codemm couldn't finish that" with a way to the connect screen. Open decision O6 covers whether to add a model setting.
7. **Isolation differs by agent.** Each agent was asked to list its tools and quote a canary file outside the workspace.
   - **Claude Code** with `--tools ""` reported only the eight Codemm tools and couldn't read the file. Built-in tools, user settings and permissive allow rules no longer matter. The server-side `--tools` filter (DESIGN §4.8) then narrows the Codemm tools to the job's own.
   - **Codex** with `--disable shell_tool --disable unified_exec --disable browser_use --disable computer_use --disable apps`, a read-only sandbox and `enabled_tools` didn't read the file. It still listed host tools that can read files (`functions.exec`, `view_image`), plus web and collaboration tools. A second run that also passed `--ignore-user-config` and disabled `code_mode_host` and `image_generation` still listed them.
   - So Codex can't be confined to Codemm's tools with documented flags. DESIGN §2.2, §3.1 and O8 cover this.
8. **Approving every Codex tool is safe only with `enabled_tools`.** `default_tools_approval_mode="approve"` lets every enabled Codemm tool run without a prompt. The spike's first version enabled every tool on the ordinary server, where `save_track` builds at once (Astra F2). Now only the job's tools are enabled, and in the app `save_track` only proposes (DESIGN §4.1).
9. **Sign-in needs no credential access.** Each agent's own status command answers it. `claude auth status` also prints the email and organization, so the bridge keeps only the boolean and drops the output.
10. **Cost.** A trivial Codex turn used about 66k input tokens (44k cached), mostly the agent's own system prompt and user config. Fresh, short jobs are still cheaper than long resumed sessions, but every job has a fixed floor.
11. **GUI discovery.** `codex` here lives in a per-shell fnm folder (`~/.local/state/fnm_multishells/...`) that a GUI app won't find. It is also a `#!/usr/bin/env node` script, so choosing the file isn't enough without a system Node. The app runs such launchers with Electron as Node (DESIGN §3.1).

## Cursor: what is known, unverified

- Headless mode: `cursor-agent -p --output-format stream-json`, `--approve-mcps` for MCP servers, `--mode ask` for read-only, `--resume [chatId]`, `--workspace <path>`.
- MCP servers come only from `.cursor/mcp.json` (project or home), so the app must write `<ws>/.cursor/mcp.json`. `cursor-agent mcp list-tools codemm` refused with "has not been approved".
- The spike didn't run `cursor-agent mcp enable`, because it changes the owner's Cursor settings.
- To verify: sign in, then run the same five checks and record a fixture for the parser (DESIGN D16).
12. **Codex has a web tool by default** (`web__run` in its tool list), which the research job can use. The spike didn't exercise web search for either agent.
