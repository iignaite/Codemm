# Desktop journey on macOS (D17)

Status: **done for 1.0 beta.** The stabilize run covered every model, workflow and failure state on the packaged app built from main at **2b6dd14** (2026-10-18). A short re-check and a human-perspective walkthrough followed on main at **8a06cd8**. Fifteen findings went to their owners as the run went (see Findings). Fixes landed on main while the run went on, so each finding is tied to the build it was seen on.

## How it runs

- **Machine:** an Apple silicon Mac (arm64), macOS 15.6.1, with Docker Desktop 27.4 using Linux containers.
- **Agents:**
  - Claude Code 2.1.283, Codex CLI 0.156.1 and cursor-agent 2026.10.16-e3cb207, on personal plans.
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` are unset.
  - The run never signs in for anyone.
- **App:**
  - `npm run dist` from main gives an unsigned dmg (ad-hoc signature); `Codemm.app` is copied out of the arm64 dmg.
  - 2b6dd14 builds the dmg with sha256 `e0e4ef1e4a689cd1…`; 8a06cd8 builds `b5add302b9235745…`.
  - The update notice needs the unpackaged build of the same commit, because a packaged app ignores `CODEMM_UPDATE_FEED`.
- **Isolation:** each run gets its own temp `CODEMM_HOME`, workspace (`desktop.json`), Electron profile and logs (`--user-data-dir`).
  - The driver snapshots the real `~/.codemm`, `~/Codemm`, profile and logs before and after, and fails the run if anything changed.
  - A run's temp data is deleted once its results are recorded; screenshots and step results stay.
- **Launch:** `PATH=<run>/bin:/usr/bin:/bin:/usr/sbin:/sbin`, with only agent launchers in `bin`. Node and npm are not on it.
- **Model:** chosen in the connect screen's Model select (#55). Each run's model is checked in the agents' own records (see Models).
- **Driver:** `desktop/e2e/journey.spec.ts` drives the UI only.
  - The learner's fixed answer is the course's own reference solution, from the run's temp `CODEMM_HOME`.
  - Every step is timed and screenshotted.
  - The window says "Codemm — automated test run, please don't use", in its title and a banner; screenshots hide the banner.
  - A walkthrough mode (`JOURNEY_WALKTHROUGH`) keeps one image per distinct screen state.
- **Simulated states** (labelled *simulated* below): no Docker (`CODEMM_TEST_SEARCH_DIRS` hides it), low disk (`CODEMM_HOME` on a 1 GB volume), offline setup (a buildx builder with no network), and the fakes (`e2e/fake-claude.cjs`, `e2e/fake-cursor-agent.cjs`).

```bash
CODEMM_JOURNEY=<run> CODEMM_APP=<Codemm.app>/Contents/MacOS/Codemm JOURNEY_AGENT=claude JOURNEY_MODEL=haiku \
  JOURNEY_PART=full JOURNEY_FLOW=reopen,show-me,stuck,pages JOURNEY_DEPTH=Overview npx playwright test e2e/journey.spec.ts
```

## Models (full courses)

| Agent and model | Build | Course | Result | Model seen in the agent's records |
|---|---|---|---|---|
| Claude Opus | 2b6dd14 | Python, Overview | **Pass**: every workflow, 14 completions, course complete, new course | `claude-opus-5-5` (260 of 260 messages) |
| Claude Haiku | 8a06cd8 | JavaScript, Overview (walkthrough) | **Pass**: course complete | `claude-haiku-4-5-20251001` (355 of 355) |
| Claude Haiku | 2b6dd14 | JavaScript, Overview | Every workflow through usage, the pages and 4 completions; stopped on a driver mix-up (fixed) | `claude-haiku-4-5-20251001` (366 of 366) |
| Claude Sonnet | 2b6dd14 | React, In depth | Research, edits, Apply, relaunches, the reopened note; setup then failed its gates (F8) | `claude-sonnet-5` (90 of 90) |
| Claude Sonnet | 2b6dd14 | Python, Overview | Stopped by request (usage) at the example Run | `claude-sonnet-5` |
| Fake Cursor (Claude behind Cursor's stream) | 2b6dd14 | Python, Overview | **Pass**: course complete; no Usage card, since Cursor reports no tokens (by design) | `claude-sonnet-5` (161 of 161) |
| Codex gpt-5.6-luna | 2b6dd14 | Ruby, Standard | Research (4–6 sources), setup, Try it, Check, Hint, Show me; authoring then failed (F12) | `gpt-5.6-luna` (all sessions in the run's folder) |

- **Codex:** not run further. The owner paused ChatGPT use on 2026-10-18. The rows above are what Codex showed before that: connect, the in-app install, research, setup (passed, then failed in a later run, F8), and authoring failures (F12). gpt-6-luna and gpt-6-astra courses were not run.
- **Cursor, real:** the earlier real run (#67) reached connect, research and edits, then hit the free plan's limit; Codemm showed the plan-limit state. The fake course above covers the adapter end to end.

## Workflows

| Workflow | Result | Where |
|---|---|---|
| First run: welcome, Install what's missing, Set up this computer | Pass | first-run, walkthrough 001–004 |
| Install Claude Code and Codex in the app (fresh HOME) | Pass; both end signed out (Codemm never signs in) | first-run, walkthrough 005–011 |
| Docker missing (simulated): Install Docker, the download starts | Pass; the download was stopped by quitting, the partial file deleted, Docker Desktop untouched | first-run, walkthrough 012–014 |
| Research with depth (Overview, Standard, In depth) and sources | Pass; 2–6 sources shown, or none | all courses |
| Roadmap edits: trim, rename, move, add, remove, Go deeper, ask with Apply | Pass | Sonnet/React |
| Setup consent, "Codemm has another way", relaunch mid-setup | Pass | Sonnet/React, all courses |
| Lesson, note, reopen, note kept | Pass (one lost note on main: F15) | all courses |
| Runnable lesson example | Pass ("Hello, World! … Exited with code 0.") | Haiku/JS |
| Try it, Run with input, Check with live progress | Pass (Visible tests → Hidden tests) | all courses |
| Tutor: Hint, Show me, solution refused | Pass | all courses |
| Mastery, stuck → easier, Skip (Come back later only when another topic is ready) | Pass | Opus, Haiku, fake Cursor |
| Review scheduling ("Review tomorrow") | Pass | Opus, Haiku, fake Cursor |
| Usage on the map | Pass (e.g. "Tokens in 274,115 / Tokens out 29,890 / Claude's estimate $1.12"); hidden for Cursor | Opus, Haiku |
| Practice and Tracks pages | Pass | all courses |
| Relaunch mid-job | Pass | Opus |
| Course complete, then a new course | Pass | Opus, fake Cursor, walkthrough |
| Switch agents mid-course (Codex → Claude) | Not run (owner paused ChatGPT); the driver handles the welcome screen it lands on | — |
| Update notice (unpackaged, local feed at 99.0.0) | Pass: "A new version is available. Get Codemm 99.0.0" | update |

## Failure states (DESIGN §5)

| State | Result | Notes |
|---|---|---|
| No Docker (simulated) | Pass | Check this computer offers Install Docker |
| Docker stopped before a Check | Pass | "This check wasn't counted / Docker isn't running." with Try again and Check this computer |
| Docker stopped during a Check | Pass | Not counted; passes once Docker is back |
| Docker stopped during setup | **F14** | Background jobs end `infra`; the stall says "Check your agent" |
| Offline: research (fake agent) | Pass, with **F13** | "You're offline. Connect to the internet, then try again."; worded as a refresh failure |
| Offline: setup (simulated) | Pass | "You're offline." with Try again; recovery not reached (driver) |
| Low disk (simulated; also seen for real on an earlier build) | Pass | "Not enough disk space. / Free some space on this computer, then try again." |
| Signed out (fake) | Pass | "Sign in to Claude Code, then try again." with Sign in and Try again |
| Plan limit (fake; also Cursor's real free plan on an earlier build) | Pass | "Your agent's plan limit is reached. Try again later." |
| Infrastructure failure while writing (fake) | Pass | "Codemm couldn't finish that." with Try again, beside the lesson and on the topic page |
| Agent Codemm can't stop (fake) | Pass on an earlier build | "Codemm couldn't stop your agent. Quit Codemm to stop it."; not restaged on 2b6dd14 (the activity was written ahead); the bridge unit tests pin it |
| Stale refresh, damaged record | Unit tests only (#128 and the repair tests) | Not rerun, to save usage |

## Findings

| # | Severity | Finding | Build |
|---|---|---|---|
| F1 | should-fix | A version Codemm itself installed shows "Untested version" | 2b6dd14 |
| F2 | polish | Connect rows stack up to five lines of metadata | 2b6dd14 |
| F3 | by design | Codex shows "Installing" before "Checking it's from OpenAI" (its true order) | 2b6dd14 |
| F4 | polish | The agent radiogroup reads "Your agent" but is named "Which agent" | 2b6dd14 |
| F5 | polish | The Docker Desktop card on Set up this computer has an empty line and no state | 2b6dd14 |
| F6 | polish | While Docker downloads, "Docker is installed" reads "Installing" three times | 2b6dd14 |
| F7 | should-fix | The Docker Desktop download can only be stopped by quitting | 2b6dd14 |
| F8 | should-fix | Agent-written track runners fail the setup gates often. React set up in 1 of 4 attempts on 2b6dd14 and 8a06cd8, and JavaScript once failed all 3 proposals on main. #160 (track output in gate messages) and #175 (probes within the time budget) landed; the failures are still agent mistakes (runners outside the project root, Dockerfile heredocs, an empty report) | 2b6dd14, 8a06cd8 |
| F9 | should-fix | A setup gate failure gives the learner no reason | 2b6dd14 |
| F11 | polish | A timed-out Run with input prints a raw "Killed" before Codemm's message | 2b6dd14 |
| F12 | should-fix | Agent-chosen track limits (128 MB, 2 s) killed every Ruby exercise's reference; the message didn't say time or memory (#175 now says which) | 2b6dd14 |
| F13 | polish | Offline research reads "Codemm couldn't refresh this." | 2b6dd14 |
| F14 | should-fix | Docker stopping during background work stalls with "Check your agent" | 2b6dd14 |
| F15 | should-fix, needs a repro | A lesson note was lost on Save while the activity was being written; the mock didn't reproduce it, and the next run kept the note | 8a06cd8 |
| — | polish | A tutor question typed during an answer gets no feedback until Send turns on | 2b6dd14 |

Notes:
- Codex's job sessions load the owner's own global Codex instructions. That is Codex's behavior under O1, not a Codemm bug.
- Two journey windows were used by hand during earlier runs; the windows are now labelled.

## Evidence

- Screenshots and step results per run: `~/Documents/Codemm/design/shots/journey-final/<run>/`.
- Walkthrough: `~/Documents/Codemm/design/shots/human-walkthrough/`, 75 images and `captions.md` with every state.
- F8 proposals and gate output: kept by the run's author until core-features' fixes settle.
