# Desktop handoff

## 2026-10-17: desktop 1.0 spec and agent bridge spike

### What changed

- **`docs/desktop/DESIGN.md`**, the desktop 1.0 spec:
  - decisions, scope and architecture;
  - the agent bridge and its turn kinds, plus the flow rules;
  - the learner-safe boundary and the core additions (§5);
  - failure states, cross-platform support and packaging;
  - cross-model robustness, acceptance criteria D1 to D25 and the test strategy;
  - the deferred list, open decisions O1 to O8, and the review log.
- **`docs/desktop/agent-bridge.md`**: the spike findings, with evidence and what is not verified.
- **`spikes/agent-bridge/`**:
  - `launch.ts`: argument arrays and the sign-in rule;
  - `events.ts`: allowlist stream parsers;
  - `run.ts`: process-group runs and cleanup;
  - `bridge.ts`: the runnable entry point;
  - node:test tests, plus fixtures recorded from real runs (scrubbed) and a fake stubborn agent.

### How it was verified

- **Tests:** `node --test spikes/agent-bridge/*.test.ts` gives 30 passing. A mutation check showed the cleanup test fails without the group kill. An ad hoc `tsc --strict --erasableSyntaxOnly` over the spike is clean.
- **Live runs:** 32 turns on the owner's subscriptions, with every API-key variable unset, using Claude Code (haiku) and Codex (gpt-6-luna). They covered:
  - start, streaming, Codemm tool calls and resume;
  - cancellation, with 0 processes left;
  - sign-in detection;
  - consent blocking and tool restriction, including a Codex control run that did execute a host shell command without the restrictions;
  - web evidence.
- **Cursor:** sign-in detection only, because it is signed out.
- **Astra:** three passes, all recorded in DESIGN.md §15:
  - a first review (1 blocker, 12 major, 2 minor);
  - a re-check (7 partly resolved, 1 new major issue);
  - a final check (the design contracts resolved, and one spike cleanup regression, now fixed).
  - Container cleanup on cancel during a gate remains unverified (D16).

### What's next

- The owner decides O1 to O8 (DESIGN.md §13).
- **Core**, after this merges: the §5 additions in `src/`, test-first, and the matching update to `docs/DESIGN.md`. That update covers lessons and `read` events, the skip change, `draft_roadmap`, `get_roadmap`, `--tools`, `--install`, `--progress`, `getExercise` returning `code`, and signal cleanup. It also removes "any UI" from core §2 "Deferred".
- **Desktop shell:** adopt the §3.3 layout, and port `launch.ts`, `events.ts` and `run.ts` into `desktop/src/main/agents/`.
- **Not yet verified:**
  - Cursor (D24);
  - Windows (D22): `.cmd` shims and `taskkill`;
  - running the MCP server with `ELECTRON_RUN_AS_NODE`;
  - assist-turn edit scoping;
  - container cleanup when a turn is cancelled during a gate (D16).
