# Codemm desktop: handoff

## What this is

An Electron, Vite, TypeScript and React app for the approved 1.0 scope (`~/Documents/Codemm/design/LEDGER.md`), built from the journey prototype (`~/Documents/Codemm/design/codemm-journeys.html`):

| Journey | Screens |
|---|---|
| Connect | welcome (asleep), connect an agent, check this computer, welcome (connected) |
| Choose | goal, suggested path, course editor, setup consent |
| Lessons | topic page while lessons are written, lesson with predict and notes (reopens instantly from a cache) |
| Practice | activity, not yet, assist consent, passed, stuck |
| Progress | course map with mastery, course complete, tracks |
| When things go wrong | the environment states below |

The UI runs against a mock core. It is not wired to the real Codemm core yet; that is the wiring session's job, after #14 and #15 merge.

### Environment states

Each state has a mock scenario, a test, and a specific next step on screen. Infrastructure failures record nothing and never blame the learner.

| State | What the learner sees | Scenario |
|---|---|---|
| No Docker | Check this computer: per-OS install steps (Windows includes WSL 2), a link to Docker's install page, and a re-check | `no-docker` |
| Docker not running | "Start Docker Desktop." (Linux: `systemctl` and the docker group), then a re-check | `docker-stopped` |
| Docker stops mid-session | "This check wasn't counted." The code stays and is saved, with a button to check this computer | `docker-stops` |
| Offline during setup | "Setting up React needs the internet once. Connect, then try again." | `offline-setup` |
| Low disk during setup | "This computer is low on disk space. Free some space, then try again." | `low-disk` |
| No agent installed | "Not installed" and a link to each agent's install page | `no-agent` |
| Agent signed out | "Sign in to Codex, then try again." Codemm never asks for or reads credentials | `signed-out` |
| Sign-in expires mid-session | the next agent call opens connect with the same line, then returns to where the learner was | `sign-in-expires` |
| Agent plan limit reached | "Your agent's plan limit is reached. Try again later." | `plan-limit` |

Check this computer runs three checks in order: Docker is installed, Docker is running, and the sandbox works. Only the first failing check shows its fix. It re-checks every 5 seconds, and at once when the window regains focus, until all three pass.

To click through a state, run `CODEMM_MOCK=no-docker npm start` (on Windows PowerShell: `$env:CODEMM_MOCK="no-docker"; npm start`). Packaged builds ignore the flag.

## Layout

```
src/shared/api.ts      CodemmApi: the only seam between UI and core, plus agent error codes
src/main/main.ts       window, security settings, the IPC handler (sender check)
src/main/ipc.ts        validates every call's method and arguments before Codemm sees them
src/main/mock.ts       in-memory CodemmApi and its named environment scenarios
src/main/links.ts      the only pages the app opens in the browser (Docker and agent install docs)
src/preload/preload.ts exposes window.codemm.invoke(method, args) and nothing else
src/renderer/app/      App (routing, failure banner), Shell (sidebar), api client, router, useLoad, cache
src/renderer/features/ connect, computer, learn, research, course, lessons, practice, progress, tracks
src/renderer/ui/       Button, Field, Switch, Dialog, Rail (the Codemm tutor), Emm, Icon, Mark
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
  - Without a certificate, macOS builds are signed ad hoc so that Gatekeeper offers Open Anyway.
  - Real signing reads only from secrets (`SIGNING.md`). Auto-update is off.

**Mocked (`src/main/mock.ts`):**
- Agents, their sign-in checks and the minimum model hint, which is a placeholder until the bench reports.
- Research (the path fills in over a few calls), lesson writing and track setup (they advance each time the UI reads the course).
- The computer check, and each environment state above.
- Grading: an unchanged starter fails 2 of 4, and any edit passes.
- Hints and replies, which are canned.
- Assist, which only turns the setting on.
- The easier activity and track rebuilds.

The mock holds no solutions and no hidden tests, and it reports hidden results as statuses only. Its React lesson content exists only for the demo and goes away with the mock.

## Plugging in the core

1. Implement `CodemmApi` on top of the core in the main process.
2. Replace `createMock(...)` in `src/main/main.ts`.

Agent calls that fail because of sign-in or the plan limit reject with `SIGNED_OUT` or `PLAN_LIMIT` in the error message, and the renderer routes on that. The renderer doesn't change otherwise. `research()`, `revise()`, `approve()` and `help(kind)` are shaped by the prototype; align them with #14's final spec in the wiring PR.

Background work is polled: screens re-read the course or the research every 500 ms until it settles. If the core can push changes, swap `useLoad`'s timer for an event.

## Removed for 1.0 (owner's scope, 2026-10-17)

- Usage and cost display: the runs-per-topic line.
- Research-source display: the "Reading" list.
- Review scheduling: the review card on the course map.
- A separate assist-edit job: "Let Codemm edit" now only turns assist on. It no longer runs a check.
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
