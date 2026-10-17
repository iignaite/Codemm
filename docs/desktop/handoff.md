# Desktop handoff

## 2026-10-17: desktop 1.0 spec and agent bridge spike

### What changed

- `docs/desktop/DESIGN.md` is the desktop 1.0 spec: scope, architecture, the agent bridge, core additions, failure states, platforms, packaging, cross-model robustness, D1 to D22, tests, a "Delete or simplify" list, the deferred list and open decisions O1 to O8.
- `docs/desktop/agent-bridge.md` has the spike findings for Claude Code and Codex. Cursor is unverified.
- `spikes/agent-bridge/` holds the proof scripts, recorded fixtures, run evidence and unit tests.
- At the owner's request, this branch also removed another product's name from README.md, CHANGELOG.md, docs/DESIGN.md and package.json. Main made the same change in #13, so after merging main nothing outside `docs/desktop/` and `spikes/` differs.

### How it was verified

- `node --test spikes/agent-bridge/*.test.mjs`: all pass.
- Real runs on the owner's subscriptions, with API-key variables unset, covered Claude Code (haiku) and Codex (gpt-6-luna):
  - a turn with Codemm tool calls;
  - resume;
  - cancellation, with no leftover processes;
  - an isolation run with a canary file outside the workspace.
  Logs are in `spikes/agent-bridge/evidence/`.
- Sign-in detection was run for all three agents. Cursor is not signed in on this machine.
- Astra's review (2 blockers, 11 more findings) and its re-check are resolved and logged in DESIGN §14. Codex confinement was settled by owner decision O8 (see the latest section).

### What's next

1. The owner decides O1 and O3 to O7 (DESIGN §13). O2, O8 and O9 are decided.
2. Core work, test-first, in this order:
   1. honest skip and the `lesson` field on `next_step`, in `learner`;
   2. proposals and `installProposal` with progress;
   3. roadmap draft, `get_roadmap` and sources;
   4. lessons;
   5. learner file read and write.
   Each moves its rules into `docs/DESIGN.md`.
3. The desktop shell ports `spikes/agent-bridge` into `desktop/src/main/agent/`, with the final launch flags (Claude `--tools ""`; Codex `--ignore-user-config`, the shell, subagents and automation off, and `enabled_tools`), job bounds, done checks, the reply filter and the views boundary. Then it deletes the spike.
4. Verify Cursor once it's signed in (D16), and Codex's web search setting for the research job.

## 2026-10-17 (later): owner-approved additions

### What changed

- **DESIGN.md additions:**
  - the lesson gate, in §4.4;
  - usage per run, a rough cost per topic, and cached lessons (§3.4);
  - agent CLI pinning with a startup check and contract tests (§3.3);
  - a recommended minimum model from the bench, a placeholder for now (§8);
  - "Check this computer" (§6.1);
  - the beta before the public 1.0 (§1, D28);
  - the signing and auto-update decision (§7.1, O9);
  - acceptance criteria D23 to D29.
- `docs/desktop/beta-plan.md`: recruiting, consent, setup, tasks, what to observe, exit criteria and the exit survey.
- The spike parses usage from `done` events and agent versions from `--version`. The sign-in helper became `ask()`, shared with the version check. 19 tests pass.
- Astra reviewed the additions and found 13 issues (8 major). All are resolved and logged in DESIGN §14.

### Notes for whoever continues

- Merges now ask the owner first. Commits and PRs carry no attribution lines.
- The bench results for the minimum model aren't committed yet (`docs/bench`). `models.json` stays `null` until they are.

## 2026-10-17 (later): owner decisions O8 and O9

- **O8 = (a).** `AGENTS.md` now reads: "Hidden data never leaves Codemm through Codemm's own outputs (tools, CLI, IPC and diagnostics). An agent with file access can read Codemm's files; Codemm removes that access where the agent allows." Codex ships with the reply filter.
- **O9 = confirmed.** Beta builds are unsigned, with open-anyway instructions, and the public 1.0 is signed.
- Both are recorded as decisions 10 and 11 in DESIGN.md.
- `docs/DESIGN.md` §1 has no hidden-data sentence, so it is unchanged. The closest are §4.2 "Disclosure" and A5, which already limit themselves to tool output, CLI output and gate diagnostics.
- Scope freeze: no new items. The scope review's cut list comes next.
