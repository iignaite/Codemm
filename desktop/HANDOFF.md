# Codemm desktop: handoff

## What this is

An Electron, Vite, TypeScript and React app for the approved 1.0 scope. It follows `docs/desktop/DESIGN.md` (merged in #14), with the journey prototype (`~/Documents/Codemm/design/codemm-journeys.html`) for the look:

| Journey | Screens |
|---|---|
| Connect | welcome (asleep), connect an agent, check this computer, welcome (connected) |
| Choose | goal, research, roadmap editor (§4.2 rules), setup consent with the proposal's files (§4.1) |
| Lessons | topic page while lessons are written, static Markdown lessons with notes (reopen instantly from a cache) |
| Practice | activity (files saved by digest), Try it, Check, passed, stuck (reread, an easier topic, come back later) |
| Progress | course map with mastery, course complete, tracks |
| When things go wrong | the environment states below |

The UI runs against a mock core. It is not wired to the real Codemm core yet; that is the wiring session's job, after #14 and #15 merge.

### Environment states

Each state has a mock scenario, a test, and a specific next step on screen. Infrastructure failures record nothing and never blame the learner.

| State | What the learner sees | Scenario |
|---|---|---|
| No Docker | Check this computer: per-OS install steps (Windows includes WSL 2), a link to Docker's install page, and a re-check | `no-docker` |
| Docker not running | "Open Docker Desktop." (Linux: `systemctl` and the docker group), then a re-check | `docker-stopped` |
| Docker still starting | "Docker is starting. This can take a few minutes." | `docker-starting` |
| Docker on Windows containers | "Switch Docker Desktop to Linux containers" | `windows-containers` |
| Docker stops mid-session | "This check wasn't counted." The code stays and is saved, with a button to check this computer | `docker-stops` |
| Offline during setup | "You're offline." Try again builds the same proposal | `offline-setup` |
| Low disk during setup | "Not enough disk space." Try again builds the same proposal | `low-disk` |
| Setup gates fail | "Couldn't set up React", then a new proposal: "Codemm has another way to set up React." | `setup-gates` |
| No agent installed | "Not installed" and a link to each agent's install page | `no-agent` |
| Agent signed out | "Sign in to Codex, then try again." Codemm never asks for or reads credentials | `signed-out` |
| Sign-in expires mid-session | the next agent call opens connect with the same line, then returns to where the learner was | `sign-in-expires` |
| Agent plan limit reached | "Your agent's plan limit is reached. Try again later." | `plan-limit` |
| Untested agent CLI version | "Untested version. It may still work." on the connect row | `untested-version` |

Check this computer runs three checks in order: Docker is installed, Docker is running, and the sandbox works. Only the first failing check shows its fix. It re-checks every 5 seconds, and at once when the window regains focus, until all three pass.

To click through a state, run `CODEMM_MOCK=no-docker npm start` (on Windows PowerShell: `$env:CODEMM_MOCK="no-docker"; npm start`). Packaged builds ignore the flag.

## Layout

```
src/shared/api.ts      the IPC contract (D3): every call, its learner-safe view, and the error codes
src/shared/roadmap.ts  roadmap edit rules (§4.2): stable ids, refused moves and removals
src/shared/models.json the recommended minimum model per agent, from docs/bench (§3.3)
src/main/main.ts       window, security settings, the IPC handler (sender check)
src/main/ipc.ts        validates every call's method and arguments before Codemm sees them
src/main/mock.ts       in-memory CodemmApi and its named environment scenarios
src/main/links.ts      the only pages the app opens in the browser (Docker and agent install docs)
src/preload/preload.ts exposes window.codemm.invoke(method, args) and nothing else
src/renderer/app/      App (routing, failure banner), Shell (sidebar), api client, router, useLoad, cache
src/renderer/features/ connect, computer, learn, research, course, lessons, practice, progress, tracks
src/renderer/ui/       Button, Field, Dialog, Markdown (safe agent text), Rail (the Codemm tutor), Emm, Icon, Mark
src/renderer/styles/   fonts.css (all font choices), tokens.css, app.css (components and motion)
e2e/smoke.spec.ts      Playwright: the main journey, plus the no-agent and no-Docker paths
packaging.cjs          electron-builder settings; signing only from the environment (SIGNING.md)
```

## Mocked versus real

**Real:**
- Window and process setup: context isolation, a sandboxed preload, no Node in the renderer, a strict CSP, and blocked navigation and new windows.
- IPC: one channel. It accepts calls only from the app's own top frame, and `ipc.ts` validates every method and argument: ids, text lengths, shapes with no extra keys, and file maps with relative paths, at most 256 files and 1 MB.
- Every screen and environment state, with keyboard and screen-reader support and the motion rules.
- Links open in the browser only for the official install pages in `links.ts`.
- The lesson cache: a lesson reopens at once from what was last loaded, then refreshes. It is cleared when a course is approved or a note is saved.
- Packaging:
  - macOS dmg (arm64 and x64) and Windows nsis (x64). There are no Linux installers for 1.0.
  - Without a certificate, macOS builds are signed ad hoc, without the hardened runtime, so that Gatekeeper offers Open Anyway and the app still launches. Checked on macOS 15.6.1: an earlier CI arm64 build (no signature) failed `codesign --verify` with "code has no resources but signature indicates they must be present", which macOS reports as damaged. The ad hoc build verifies, Gatekeeper rejects it as unnotarized (the Open Anyway case), and once allowed it launches and responds.
  - Real signing reads only from secrets (`SIGNING.md`). Auto-update is off.

**Mocked (`src/main/mock.ts`):**
- Agents, their sign-in checks and the minimum model hint, which is a placeholder until the bench reports.
- Research (the path fills in over a few calls), lesson writing and track setup (they advance each time the UI reads the course).
- The computer check, and each environment state above.
- Grading: an unchanged starter fails 2 of 4, and any edit passes.
- Hints and replies, which are canned.
- The easier topic (a roadmap-change job in the core), skip, and track rebuilds.

The mock holds no solutions and no hidden tests, and it reports hidden results as statuses only. Its React lesson content exists only for the demo and goes away with the mock.

## Wiring: the real core and agents (stacked PR)

The app now runs the real core and the learner's agent. The mock only runs for tests and the dev switcher (`CODEMM_MOCK`).

```
src/main/wire.ts          composition root: bundled core, Docker and agent lookup, the live API
src/main/live.ts          CodemmApi over core app functions, agent jobs and views
src/main/views.ts         learner-safe projections and the reply filter (§2.2, D4)
src/main/courseView.ts    the course as the learner sees it, from progress, lessons, setup and jobs
src/main/connect.ts       agents: found or not, sign-in yes or no, tested version, recommended model
src/main/computer.ts      Check this computer: Docker found, answering with Linux containers, sandbox (§6.1)
src/main/state.ts         desktop.json: chosen agent and tutor sessions, atomic, format_version
src/main/agent/           agents (launch, parse, status), bridge (spawn, cancel, caps), find, jobs, briefs
src/main/core/            the core functions used, and adapters for the ones core doesn't have yet
scripts/bundle-core.mjs   esbuild bundles the repo's core into out/core: cli.mjs (the MCP server) and app.cjs (in-process)
e2e/packaged.spec.ts      D1, in CI on macOS and Windows: no Node on PATH, the bundled MCP server, a JavaScript agent
```

**Adapters, marked in the code:**
- `core/adapters.ts`: functions from the core desktop additions (PR #23), such as lessons, proposals, `getRoadmap` and learner file saves. Until #23 merges, the bundled core doesn't have them, and a call says "This needs the core desktop additions (PR #23)." The `--course`, `--tools` and `--desktop` options of `codemm mcp` come with #23 too.
- `agent/briefs.ts`: the per-job briefs. The spec puts them in core `templates.ts`.

**Verified here:**
- Unit tests over fixtures, fake agents and a fake core:
  - agent stream contracts from the recorded fixtures;
  - launch flags;
  - cancel of the whole process group, line caps, and status commands with a deadline and cap;
  - executable lookup, including `.cmd` shims;
  - job bounds, the done check, plan-limit and sign-out handling, and at most one relaunch;
  - views and the reply filter;
  - the computer check;
  - the live API flows;
  - the D4 canary across every IPC handler.
- The packaged arm64 app, locally: it launched with only a fake JavaScript agent on PATH, its bundled `codemm mcp` answered `list_tracks` through Electron as Node, and the agent connected.

**Not verified yet:**
- A real-agent journey (D17), and a real-core canary run. Both need #23 merged and Docker.
- Windows `taskkill` cancellation, except in CI's smoke test.
- Claude Code's `--tools` value for the research job's web search.
- The plan-limit markers, until each is recorded as a fixture.
- Leftover-container cleanup after a crash isn't wired yet: core `doctor --fix`'s rule.

## Removed for 1.0 (owner's scope, 2026-10-17)

- Usage and cost display: the runs-per-topic line.
- Research-source display: the "Reading" list.
- Review scheduling: the review card on the course map.
- Assist in the app, including "Let Codemm edit" (deferred in §12: the tutor explains, the learner edits).
- Predict questions and editable lesson text (§12); lessons are static Markdown with notes.
- Linux installers.

## Reviews

- **First Astra review**, seven findings, all fixed:
  - unchecked code lost on navigation or assist;
  - a repeat pass re-advancing topics;
  - Approve mid-rename;
  - racing agent connects;
  - the error toast escaping the modal;
  - the focus ring's contrast;
  - looping animations.
- **Second Astra review**, three findings, all fixed:
  - the lesson cache across replaced courses;
  - a stale read hiding a saved note;
  - focus lost when a computer check turns ready.
- **Third Astra review**, of the 1.0 trim, seven findings, all fixed:
  - edits lost when sign-in expired during a roadmap request;
  - research errors skipping the sign-in and plan-limit handling;
  - overlapping computer checks on window focus;
  - inherited keys slipping past IPC shapes;
  - Windows-unsafe file paths;
  - PR builds skipping the ad-hoc signature (electron-builder skips signing on PRs unless `CSC_FOR_PULL_REQUEST` is set);
  - a release re-run able to change a published release.

## Decisions

- **No router or state library.** A `Route` union in `app/router.ts` covers about ten screens.
- **No code editor library.** A plain textarea with a line gutter. Syntax highlighting is language-specific, and Codemm ships no languages.
- **Fonts.** Display is Schibsted Grotesk, text and UI is Atkinson Hyperlegible Next, and code is JetBrains Mono. They ship as woff2 files (latin subset, only the weights used) in `src/renderer/assets/fonts`, with their OFL licenses, which the installers also carry. Every family is set in `src/renderer/styles/fonts.css`. The wordmark is the outlined brand SVG from `docs/brand`.
- **Real title bar.** `titleBarStyle: 'hidden'` plus a drag region, with window controls overlaid on Windows.
- **Reordering.** Topics can be dragged. The grip button also opens a Move up/Move down menu, so dragging is never required.
- **Copy changed from the prototype:**
  - The setup-failed card states the actual problem, rather than "Codemm is trying another way."
  - The course picker has no chevron, because there is only one course.

## Verify

```bash
npm ci
npm run typecheck
npm test            # Vitest and Testing Library
npm run test:e2e    # builds, then the Playwright Electron smoke tests
npm run dist        # installers in release/
```

- `.github/workflows/desktop.yml` runs all of this on macOS and Windows for PRs that touch `desktop/`, and uploads the installers as artifacts.
- `.github/workflows/desktop-release.yml` runs on a `v*` tag. It builds both installers, signing them if the secrets are set, and attaches them to a draft GitHub Release. Only the owner publishes it.

## Next

- Wire the core and the agents in place of the mock, following #14.
- Add the untested-agent-CLI-version warning (in scope for 1.0, not built yet).
- Signing and notarization once the owner has the accounts (`SIGNING.md`), then auto-update.
