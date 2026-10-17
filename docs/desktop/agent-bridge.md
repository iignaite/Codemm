# Agent bridge spike: findings

Question: can the desktop app start the learner's own agent CLI headless, give it Codemm's MCP server and nothing else, stream its replies, see its Codemm tool calls, stop it cleanly, and tell whether it's signed in, all without touching credentials?

**Answer: yes for Claude Code and Codex, verified on macOS on 17 Oct 2026. Cursor is installed but signed out, so only its sign-in detection is verified.**

Code: `spikes/agent-bridge/`.

- `launch.ts` builds the argument arrays and reads sign-in status.
- `events.ts` parses the streams.
- `run.ts` runs a turn as its own process group and cleans up.
- `bridge.ts` is the runnable entry point.

The unit tests run against recordings of real streams, with workspace paths and account details removed, and against a fake agent that won't stop.

```bash
npm run build
node --test spikes/agent-bridge/*.test.ts
node spikes/agent-bridge/bridge.ts status claude
node spikes/agent-bridge/bridge.ts turn claude --model haiku "Call the codemm list_tracks tool, then reply with one line."
```

## Setup

- **Versions:** Claude Code 2.1.283, codex-cli 0.156.1, Cursor Agent 2026.01.23, and Node 22.18 on macOS 15 (Darwin 24.6).
- **Plans:** the owner's personal subscriptions. Every run unset `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `CURSOR_API_KEY`. Claude's init event reported `apiKeySource: "none"`, which confirms that no key was used.
- **Models:** Claude `haiku` and Codex `gpt-6-luna`, the small models. 28 turns in all, before and after Astra's review, plus config probes that made no model call.
- **Codemm:** each run used a fresh temp workspace and `CODEMM_HOME`, with this checkout's `dist/cli.js mcp --workspace <ws>` as the MCP server.

## Results

| Requirement | Claude Code | Codex | Cursor |
|---|---|---|---|
| Headless start, with MCP pointing at `codemm mcp` | Yes: `--mcp-config <json> --strict-mcp-config` | Yes: `-c mcp_servers.codemm.*` overrides | not run (signed out) |
| Streamed output parsed into events | Yes: `stream-json` | Yes: `exec --json` | not run |
| Tool calls to Codemm | Yes: `list_tracks` ok, `progress` failed (no course) | Yes: the same | not run |
| Next turn in the same session | Yes: `--resume <session_id>` | Yes: `exec resume <thread_id>` | not run |
| Cancellation with nothing left running | Yes: 2 processes in the group at cancel, 0 after | Yes: the same | not run |
| Sign-in detection without credential access | Yes: `claude auth status` → `loggedIn` | Yes: `codex login status` → exit code and text | Yes: `cursor-agent status` → "Not logged in" |
| No file, shell or other MCP tools in a tutor turn | Yes: `--tools ""` | Yes: `--ignore-user-config` and shell features disabled | not run |
| An unapproved `save_track` is blocked | Yes: permission denied | Yes: the tool isn't exposed | not run |
| Web search leaves URL evidence | Yes: `WebSearch` results and `WebFetch` input | Yes: `web_search` item results | not run |

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
```

Codex gave the same events for the same prompt.

**Resuming.** Both agents named the tools from the previous turn without calling any, before and after the restrictions were added.

**Tool restriction.** The prompt was "create note.txt, or run `pwd`, then call `list_tracks`". With the restricted flags, neither agent wrote a file or ran a command:

- Claude's init listed only the eight `mcp__codemm__*` tools.
- Codex said "no shell tool was available".
- The workspace had no `note.txt`.

A control run of Codex without the restrictions did run `/bin/zsh -lc pwd` on the host.

**Cancellation.** The cancel came 15 s into a long turn, through `run.ts`:

```
claude: {"kind":"cancel","ms":15041} {"kind":"exit","code":143,"cancelled":true,"atCancel":2,"leftover":0,"ms":18193}
codex:  {"kind":"cancel","ms":15108} {"kind":"exit","code":0,"cancelled":true,"atCancel":2,"leftover":0,"ms":15501}
```

**Web evidence.** These were author turns (`--author`), so no text was shown:

```
claude: {"kind":"web","urls":["https://lynxjs.org/next/api/react/Function.useState","https://react.dev/reference/react/useState.md",…]}
codex:  {"kind":"web","urls":["https://uk.react.dev/reference/react/useState","https://react.dev/learn/state-as-a-snapshot",…]}
```

**Sign-in.** `{"agent":"claude","signedIn":true}`, `{"agent":"codex","signedIn":true}`, `{"agent":"cursor","signedIn":false}`. With `PATH=/usr/bin:/bin`, Claude came back `installed: false`.

**Consent.** The prompt asked for `save_track` when only `list_tracks` was allowed:

- Claude: the `save_track` call started, then failed, with "Permission required to call mcp__codemm__save_track…".
- Codex: no tool event; it replied "I couldn't call codemm.save_track: it isn't available here…".

## Findings

1. **Allowlists alone don't restrict an agent.**
   - Claude's `--allowedTools` only pre-approves tools; `--tools` decides which built-in tools exist, and `--tools ""` leaves none. With `--strict-mcp-config`, only Codemm's MCP server is loaded.
   - Codex's read-only sandbox still lets it run host commands, and the user's config adds its own MCP servers. `--ignore-user-config` (auth still works) and `--disable` for `shell_tool`, `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use`, `multi_agent` and `image_generation` remove them.
2. **Codex blocks MCP tools by default in `exec`.** The first run failed with "MCP tool call requires approval, but approval policy is never". The fix is a per-server allowlist: `enabled_tools=[…]` with `default_tools_approval_mode="approve"` (the valid values are `auto`, `prompt`, `writes` and `approve`). This doubles as a consent control.
3. **A weak model answered as if the blocked call had worked.** It replied "0" tracks although `list_tracks` never ran (fixture `codex-approval-blocked.jsonl`). Every turn is judged by Codemm's state and tool events, never by the agent's text.
4. **Codex rejects the user's default model on a ChatGPT plan.** `gpt-6.1-sol` failed with a 400 error, and the turn ended with `turn.failed` (fixture `codex-model-rejected.jsonl`). The error text isn't shown. A failed handshake while signed in leads to "choose another model" (O5).
5. **`codex exec resume` doesn't accept `-s` or `-C`.** The sandbox is set with `-c sandbox_mode=…` on every turn, and the working folder is the process's working directory.
6. **The prompt goes on stdin for both agents.** This avoids two problems: Claude's variadic options consuming the prompt, and Windows' command-line length limit.
7. **Stopping needs the whole process group.**
   - Claude runs its SessionEnd hooks on SIGTERM; it once took more than 3 s, so the grace period is 5 s.
   - `run.ts` kills whatever is left in the group whenever the agent exits, and counts members by group id rather than by command line. The fake-agent test proves this, and fails when the cleanup is removed.
   - Killing the group doesn't remove Docker containers, which is why the spec adds signal cleanup and `doctor`'s owner-aware sweep (spec §5.8).
8. **The learner's own Claude settings still apply.** The owner's global hooks ran inside every turn (they show as `hook_*` events, and as SessionEnd messages on cancel). The parser ignores them. Whether to skip them is open decision O4.
9. **Claude may load MCP tools through ToolSearch first** when it has many tools. The parser reports only Codemm tools, so this never shows.
10. **Streaming granularity differs.** Claude emits one event per assistant message (token deltas are available with `--include-partial-messages`, which is deferred). Codex emits completed `agent_message` items only. One event per message is the common ground.
11. **First-event latency** was about 0.5 to 7 s for Codex and 3 to 14 s for Claude, which runs the user's startup hooks first. The UI needs a "thinking" state from the moment a turn starts.
12. **Apps opened from a desktop may not find the agents.** With a minimal `PATH` (like apps launched from Finder), `claude` wasn't found.
13. **Sign-in output carries account details** (Claude's JSON includes email and organization). The bridge keeps only the yes/no.
14. **Error text and author text are dropped at the parser.** A failed turn is just `{ ok: false }`, and author turns pass `text: false`. Malformed lines are ignored rather than thrown (tests cover `content: [null]`, non-string text and `javascript:` URLs).
15. **Web evidence has a stable shape in both agents.** Claude's search URLs are in `tool_use_result.results[].content[].url` and its fetch URL is in `WebFetch`'s input. Codex's are in `web_search` items' `results[].url`. The parser keeps `https:` URLs only.

## Not verified here

- **Cursor turns.** `cursor-agent` is installed and signed out, and entering credentials is out of scope. Its headless flags (`-p --output-format stream-json --approve-mcps`, MCP from `.cursor/mcp.json`, and `--mode ask`) come from its `--help`. It stays experimental until verified (D24).
- **Assist turns:** scoped editing permissions for either agent.
- **Windows and Linux.** Spawning `.cmd` shims, `taskkill`, and Docker Desktop paths on WSL2 aren't verified (D21, D22).
- **Running the MCP server with Electron** (`ELECTRON_RUN_AS_NODE=1`). The spike used the system Node.
- **Multi-step journeys** (research, authoring, setup) with small models. That is the cross-model bench's job (D23).
