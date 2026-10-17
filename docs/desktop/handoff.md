# Desktop handoff

## 2026-10-17: desktop 1.0 spec and agent bridge spike

### What changed

- `docs/desktop/DESIGN.md` is the desktop 1.0 spec: scope, architecture, the agent bridge, core additions, failure states, platforms, packaging, cross-model robustness, D1 to D20, tests, a "Delete or simplify" list, the deferred list and open decisions O1 to O7.
- `docs/desktop/agent-bridge.md` has the spike findings for Claude Code and Codex. Cursor is unverified.
- `spikes/agent-bridge/` holds the proof scripts, recorded fixtures, run evidence and 17 unit tests.
- At the owner's request, the four mentions of another product's name are gone from README.md, CHANGELOG.md, docs/DESIGN.md and package.json (commit f72742e). This is the only change outside `docs/desktop/` and `spikes/`.

### How it was verified

- `node --test spikes/agent-bridge/*.test.mjs`: 17 pass.
- Real runs on the owner's subscriptions, with API-key variables unset, covered Claude Code (haiku) and Codex (gpt-6-luna):
  - a turn with Codemm tool calls;
  - resume;
  - cancellation, with no leftover processes;
  - an isolation run with a canary file outside the workspace.
  Logs are in `spikes/agent-bridge/evidence/`.
- Sign-in detection was run for all three agents. Cursor is not signed in on this machine.
- Astra's review (2 blockers, 11 more findings) is resolved and logged in DESIGN §14. A re-check follows.

### What's next

1. The owner decides O1 to O7 (DESIGN §13).
2. Core work, test-first, in this order:
   1. honest skip and the `lesson` field on `next_step`, in `learner`;
   2. proposals and `installProposal` with progress;
   3. roadmap draft, `get_roadmap` and sources;
   4. lessons;
   5. learner file read and write.
   Each moves its rules into `docs/DESIGN.md`.
3. The desktop shell ports `spikes/agent-bridge` into `desktop/src/main/agent/`, adding job bounds and the views boundary.
4. Verify Cursor once it's signed in (D16), and Codex's web search setting for the research job.
