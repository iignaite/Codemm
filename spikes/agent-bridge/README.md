# Agent bridge spike

These scripts prove that Codemm can start the learner's agent CLI with Codemm's MCP server, stream and parse its output, cancel it, and detect sign-in. Findings are in [docs/desktop/agent-bridge.md](../../docs/desktop/agent-bridge.md).

The spike is throwaway: the desktop app reimplements it in `desktop/src/main/agent/`.

```bash
node --test spikes/agent-bridge/*.test.mjs      # no agents or models needed
npm run build                                   # the runs serve dist/cli.js
node spikes/agent-bridge/spike.mjs status
node spikes/agent-bridge/spike.mjs run claude --model haiku "Call the codemm list_tracks tool once."
node spikes/agent-bridge/spike.mjs run codex --model gpt-6-luna --cancel-on tool_call "Call the codemm list_tracks tool."
```

Runs remove API-key variables, so they use your signed-in plan.
