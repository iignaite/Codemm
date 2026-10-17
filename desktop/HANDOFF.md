# Codemm desktop: handoff

## What this is

An Electron, Vite, TypeScript and React shell for every screen in the approved journey prototype (`~/Documents/Codemm/design/codemm-journeys.html`):

| Journey | Screens |
|---|---|
| Connect | welcome (asleep), connect an agent, welcome (connected) |
| Choose | goal, research, course editor, setup dialog |
| Lessons | topic page while lessons are written, lesson with predict and notes |
| Practice | activity, not yet, assist dialog, passed, stuck |
| Progress | course map with review and mastery, course complete, tracks |
| When things go wrong | check not counted (sandbox down), setup failed |

The UI runs against a mock core. It is not wired to the real Codemm core yet.

## Layout

```
src/shared/api.ts      CodemmApi: the only seam between UI and core (types only)
src/main/main.ts       window, security settings, one IPC handler
src/main/mock.ts       in-memory CodemmApi (the stand-in for the core)
src/preload/preload.ts exposes window.codemm.invoke(method, args) and nothing else
src/renderer/app/      App (routing), Shell (sidebar), api client, router, useLoad
src/renderer/features/ connect, learn, research, course, lessons, practice, progress, tracks
src/renderer/ui/       Button, Field, Switch, Dialog, Rail (the Codemm tutor), Emm, Icon, Mark
src/renderer/styles/   tokens.css (prototype tokens), app.css (components and motion)
e2e/smoke.spec.ts      Playwright launches the built app and walks the main journey
```

## Mocked versus real

**Real:**
- Window and process setup: context isolation, sandboxed preload, no Node in the renderer, a strict CSP, and blocked navigation and new windows.
- IPC: one channel, which only accepts calls from the app's own page and only for methods the core object has.
- Every screen and state, with keyboard and screen-reader support and the motion rules.
- Packaging: unsigned dmg (arm64 and x64), nsis (x64), and AppImage plus deb (x64).

**Mocked (`src/main/mock.ts`):**
- Agent connections.
- Research, which advances one source per call.
- Lesson writing and track setup, which advance each time the UI reads the course.
- Grading: an unchanged starter fails 2 of 4, and any edit passes.
- Saving drafts: practice code is autosaved shortly after typing stops, and when the learner leaves.
- Hints and replies, which are canned.
- Assist, which turns the flag on but edits nothing.
- The easier activity and track rebuilds.

The mock holds no solutions and no hidden tests, and it reports hidden results as statuses only. Its React lesson content exists only for the demo and goes away with the mock.

## Plugging in the core

1. Implement `CodemmApi` on top of the core in the main process.
2. Replace `createMock()` in `src/main/main.ts`.

The renderer doesn't change. Expect to adjust `api.ts` once `docs/desktop/DESIGN.md` lands (agent connection, research and roadmap editing). These calls are guesses shaped by the prototype:
- `research()`, `revise()` and `approve()`;
- `review` on `Course`;
- `help(kind)`.

Background work is polled: screens re-read the course or the research every 500 ms until it settles. If the core can push changes, swap `useLoad`'s timer for an event.

## Review

Astra reviewed the first commit and found seven real issues; all are fixed and covered by tests:
1. Unchecked code was lost on navigation or assist. Drafts now autosave.
2. A repeat pass re-advanced the mock's topics.
3. Approve worked mid-rename. It is now disabled while editing.
4. Concurrent agent connects raced. They now run one at a time.
5. The error toast could escape the modal. The dialog now portals and makes the rest of the window inert.
6. The green focus ring failed 3:1 contrast on light surfaces. It is now navy there and green on navy.
7. Spinners, shimmers and sparkles looped beyond two repeats.

## Decisions

- **No router or state library.** A `Route` union in `app/router.ts` covers about ten screens.
- **No code editor library.** A plain textarea with a line gutter. Syntax highlighting is language-specific, and Codemm ships no languages.
- **Fonts.** Display is Schibsted Grotesk, text and UI is Atkinson Hyperlegible Next, and code is JetBrains Mono. They ship as woff2 files (latin subset, only the weights used) in `src/renderer/assets/fonts`, with their OFL licenses, which the installers also carry. Every family is set in `src/renderer/styles/fonts.css` through `--display`, `--sans` and `--mono`, and the app never fetches fonts. The wordmark is the outlined brand SVG from `docs/brand`, so it needs no Poppins.
- **Real title bar.** The prototype's bar is a real one: `titleBarStyle: 'hidden'` plus a drag region, with window controls overlaid on Windows and Linux.
- **Reordering.** Topics can be dragged. The grip button also opens a Move up/Move down menu, so dragging is never required.
- **Assist.** "Let Codemm edit" turns assist on and then runs Check, matching the prototype's flow from assist to passed.
- **Copy changed from the prototype:**
  - The setup-failed card says "Try again, or change the course." The prototype said "Codemm is trying another way." The mock doesn't retry by itself, so that wording wasn't true.
  - The course picker has no chevron, because there is only one course.

## Verify

```bash
npm ci
npm run typecheck
npm test            # Vitest and Testing Library
npm run test:e2e    # builds, then the Playwright Electron smoke test
npm run dist        # unsigned installers in release/
```

The CI workflow `.github/workflows/desktop.yml` runs all of this on macOS, Windows and Ubuntu for PRs that touch `desktop/`, and uploads the installers as artifacts.

## Next

- Wire the core in place of the mock, following `docs/desktop/DESIGN.md`.
- Persist the window's route across launches, if wanted. Today every launch starts at the welcome screen.
- Signing and notarization, when the owner decides to publish.
