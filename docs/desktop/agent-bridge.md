# Agent bridge spike: findings

Question: can the desktop app start the learner's own agent CLI headless, give it Codemm's MCP server, stream its replies, see its Codemm tool calls, stop it, and tell whether it's signed in, all without touching credentials?

**Answer: yes for Claude Code and Codex, verified on macOS on 17 Oct 2026. Cursor is installed but signed out, so only its sign-in detection is verified.**

Code: `spikes/agent-bridge/`. `launch.ts` builds the argument arrays, `events.ts` parses the streams, and `bridge.ts` is the runnable entry point. Unit tests run against recordings of real streams, with workspace paths and account details removed.

```bash
npm run build
node --test spikes/agent-bridge/*.test.ts
node spikes/agent-bridge/bridge.ts status claude
node spikes/agent-bridge/bridge.ts turn claude --model haiku "Call the codemm list_tracks tool, then reply with one line."
```

## Setup

- **Versions:** Claude Code 2.1.283, codex-cli 0.156.1, Cursor Agent 2026.01.23, and Node 22.18 on macOS 15 (Darwin 24.6).
- **Plans:** the owner's personal subscriptions. Every run unset `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `CURSOR_API_KEY`. Claude's init event reported `apiKeySource: "none"`, which confirms that no key was used.
- **Models:** Claude `haiku` and Codex `gpt-6-luna`, the small models. 13 turns in all, plus two config probes that made no model call.
- **Codemm:** each run used a fresh temp workspace and `CODEMM_HOME`, with this checkout's `dist/cli.js mcp --workspace <ws>` as the MCP server.

## Results

| Requirement | Claude Code | Codex | Cursor |
|---|---|---|---|
| Headless start with MCP pointing at `codemm mcp` | Yes: `--mcp-config <json> --strict-mcp-config` | Yes: `-c mcp_servers.codemm.*` overrides | not run (signed out) |
| Streamed output parsed into events | Yes: `stream-json` | Yes: `exec --json` | not run |
| Tool calls to Codemm | Yes: `list_tracks` ok, `progress` failed (no course) | Yes: the same | not run |
| Next turn in the same session | Yes: `--resume <session_id>` | Yes: `exec resume <thread_id>` | not run |
| Cancellation, with no leftover processes | Yes: SIGTERM to the process group, 0 left | Yes: the same, 0 left | not run |
| Sign-in detection without credential access | Yes: `claude auth status` → `loggedIn` | Yes: `codex login status` → exit code and text | Yes: `cursor-agent status` → "Not logged in" |
| Unapproved `save_track` blocked | Yes: permission denied | Yes: tool not exposed | not run |

### Evidence (parsed events; `ms` is the time since start)

Claude Code, one turn calling two tools:

```
{"kind":"session","id":"25129d16-…"}
{"kind":"tool","tool":"list_tracks","state":"started"}
{"kind":"tool","tool":"progress","state":"started"}
{"kind":"tool","tool":"list_tracks","state":"ok"}
{"kind":"tool","tool":"progress","state":"failed"}
{"kind":"text","text":"This workspace has no installed tracks or courses yet…"}
{"kind":"done","ok":true}
{"kind":"exit","code":0,"leftover":0}
```

Codex, the same prompt:

```
{"kind":"session","id":"01a14a28-…"}
{"kind":"tool","tool":"list_tracks","state":"started"}
{"kind":"tool","tool":"list_tracks","state":"ok"}
{"kind":"tool","tool":"progress","state":"started"}
{"kind":"tool","tool":"progress","state":"failed"}
{"kind":"text","text":"No tracks are installed, and there's no course in this workspace yet."}
{"kind":"done","ok":true}
```

Resuming the session: both agents correctly named the two tools from the previous turn without calling any.

Cancellation, 15 s into a long turn, with 2 to 3 processes holding the workspace (the agent and `codemm mcp`):

```
claude: {"kind":"tool","tool":"list_tracks","state":"ok","ms":12523} {"kind":"cancel","holding":2,"ms":15849} {"kind":"exit","code":143,"leftover":0,"ms":19403}
codex:  {"kind":"session",…,"ms":7231} {"kind":"cancel","holding":3,"ms":15396} {"kind":"exit","code":0,"leftover":0,"ms":16609}
```

Sign-in: `{"agent":"claude","signedIn":true}`, `{"agent":"codex","signedIn":true}`, `{"agent":"cursor","signedIn":false}`. With `PATH=/usr/bin:/bin`, Claude came back `installed: false`.

Consent, with a prompt asking for `save_track` when only `list_tracks` was allowed:

```
claude: tool save_track started → failed; text "Permission required to call mcp__codemm__save_track…"
codex:  no tool event; text "I couldn't call codemm.save_track: it isn't available here…"
```

## Findings

1. **Codex blocks MCP tools by default in `exec`.** The first run failed with "MCP tool call requires approval, but approval policy is never". The fix is a per-server allowlist: `enabled_tools=[…]` plus `default_tools_approval_mode="approve"` (the valid values are `auto`, `prompt`, `writes` and `approve`). This doubles as the consent control (spec §5.4).
2. **A weak model answered as if the blocked call had worked.** It replied "0" tracks although `list_tracks` never ran (fixture `codex-approval-blocked.jsonl`). That is why every turn is judged by Codemm's state and tool events, never by the agent's text (spec §9).
3. **Codex rejects the user's default model on a ChatGPT plan.** `gpt-6.1-sol` failed with a 400 error ("not supported when using Codex with a ChatGPT account"), and the turn ended with `turn.failed`. The app needs a model choice and a clear error for this (open decision O5). The fixture is `codex-model-rejected.jsonl`.
4. **`codex exec resume` doesn't accept `-s` or `-C`.** The sandbox is set with `-c sandbox_mode="read-only"` on every turn, and the working folder is the process's working directory.
5. **The prompt goes on stdin for both agents.** This avoids two problems: Claude's variadic options (`--allowedTools`, `--mcp-config`) consuming the prompt, and Windows' command-line length limit.
6. **Claude needs time to stop.** On SIGTERM it runs its SessionEnd hooks. In one run it took more than 3 s and needed SIGKILL; in another it exited with 143 after about 3.5 s. Use a 5 s grace period. Codex exited at once.
7. **Killing the process group stops the MCP server too.** Every cancelled or finished run left 0 processes holding the workspace. Windows needs `taskkill /T /F` (not run here).
8. **The learner's own Claude settings apply to headless turns.** The owner's global hooks and plugins ran inside every turn (they show as `hook_*` events, and as SessionEnd messages on cancel). The parser ignores them. Whether to isolate tutor turns is open decision O4.
9. **Claude may load MCP tools through ToolSearch first.** Haiku did this unprompted. The parser reports only Codemm tools, so this plumbing never shows.
10. **Streaming granularity differs.** Claude emits one event per assistant message (token deltas are available with `--include-partial-messages`, which is deferred). Codex emits completed `agent_message` items only. One event per message is the common ground.
11. **First-event latency** was about 0.6 to 7 s for Codex (thread start) and about 4 to 5 s for Claude, which runs the user's startup hooks first. The UI needs a "thinking" state from the moment a turn starts.
12. **Apps opened from a desktop may not find the agents.** With a minimal `PATH` (like apps launched from Finder), `claude` wasn't found. The app must search the standard install folders (spec §6).
13. **Sign-in output carries account details** (Claude's JSON includes email and organization). The bridge keeps only the yes/no.
14. **Research turns:** Codex's web search is configured with `web_search` (`disabled`, `cached`, `indexed` or `live`), and Claude's with the `WebSearch` and `WebFetch` tools. Both settings were confirmed to exist; searches weren't run.

## Not verified here

- **Cursor turns.** `cursor-agent` is installed and signed out, and entering credentials is out of scope. Its headless flags (`-p --output-format stream-json --approve-mcps`, MCP from `.cursor/mcp.json`, and `--mode ask` for read-only) come from its `--help`. Until it is verified it stays experimental (D21).
- **Windows and Linux.** Spawning `.cmd` shims, `taskkill` and the Docker Desktop on WSL2 paths aren't verified (D18 and D19).
- **Running the MCP server with Electron** (`ELECTRON_RUN_AS_NODE=1`). The spike used the system Node.
- **Multi-step journeys** (research, authoring, setup) with small models. That is the cross-model bench's job (D20).
