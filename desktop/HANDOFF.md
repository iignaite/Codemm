# Codemm desktop: handoff

The desktop shell, built from the approved journey prototype (`codemm-journeys.html`). Electron, Vite, React and TypeScript, packaged with electron-builder. It runs against an in-memory mock behind one typed seam, `CodemmApi`.

## Commands

Run these from `desktop/`. This package has its own `package.json` and lockfile, separate from the core.

```bash
npm ci
npm run dev          # Electron with hot reload
npm run typecheck
npm test             # Vitest + Testing Library (jsdom)
npm run test:smoke   # build, then a Playwright Electron walk through the journey
npm run dist         # unsigned installers in dist/
```

`.npmrc` sets `legacy-peer-deps=true`. Without it, npm 11's peer resolver crashes on vitest's optional browser peers, which this package doesn't use.

## Layout

| Path | Job |
|---|---|
| `src/shared/api.ts` | The IPC contract: `CodemmApi`, its learner-safe types, and the channel names |
| `src/main/index.ts` | Window setup: sandboxed and context-isolated, with no navigation or new windows |
| `src/main/ipc.ts` | Thin handlers that forward each `CodemmApi` call and accept only the app window |
| `src/main/mock.ts` | The in-memory `CodemmApi`, the only implementation for now |
| `src/preload/index.ts` | Exposes `window.codemm: CodemmApi` and nothing else |
| `src/renderer/app/` | Routing (`nav.tsx`), API context (`api.tsx`), shell layouts, focus on navigation |
| `src/renderer/features/*` | `connect`, `learn` (goal), `research`, `course` (edit and approve), `lessons`, `practice`, `progress`, `tracks` |
| `src/renderer/ui/` | `Button`, `Field`, `Chip`, `Switch`, `Dialog`, `Menu`, `Rail` (the Codemm rail), `Emm`, icons |
| `src/renderer/styles/` | Tokens and component CSS ported from the prototype |

## What's mocked and what's real

**Real:**
- every screen and state in the prototype;
- navigation, motion and reduced motion;
- accessibility semantics;
- the IPC bridge, with its sender check;
- window hardening;
- packaging for macOS (dmg, arm64 and x64), Windows (nsis, x64) and Linux (AppImage and deb, x64);
- CI.

**Mocked** (`src/main/mock.ts`):
- **Agents.** Connecting always succeeds; the failed state is tested with a stub. No agent is contacted.
- **Research.** A fixed source list and the prototype's React path.
- **Revising the course.** `reviseDraft` appends the request as a topic.
- **Track setup.** A timer. `failSetup` (tests only) shows the failure screen. Nothing is downloaded or built.
- **Lessons.** Two fixed lessons per topic. Edits and notes are kept in memory.
- **Grading.** Scripted. A check of unchanged starter code is graded but not counted (`recorded: false`). The first changed check is "2 of 4"; the next passes and masters the topic. The mock holds no solution, reference or hidden tests: hidden results are statuses only, and a test enforces this.
- **Tutor replies** (`ask`, `hint`). Canned. Asking for a fix while assist is off returns the practice-mode lock note.
- **Assist.** Stored as a flag. "Let Codemm edit" turns it on, but nothing edits the code.
- **Drafts.** Each edit calls `saveFiles` and is kept in memory, so leaving Practice keeps the code.
- **Persistence.** None. A restart starts again at the welcome screen.

## Plugging in the core

Replace `createMockApi()` in `src/main/index.ts` with an adapter that implements `CodemmApi` on the core's `app` module. The main process is Node, so it can import the core directly. Notes for that adapter:
- `saveFiles` fires on every edit; write the draft to the workspace and coalesce writes if needed. `check` and `test` also receive the editor's files: write them, then call `app.check` or `app.testExercise`.
- Map infrastructure failures to `{ kind: 'infra' }`. Learner-caused failures stay `graded`.
- `setAssist(true)` must keep the core's semantics: sticky per exercise, weighted at 0.25.
- `onChange` should fire after any state change, so screens reload.
- Nothing hidden may cross IPC. `CodemmApi` has no field that could carry it, so keep it that way.

`docs/desktop/DESIGN.md` (being written in a parallel session) defines the agent bridge, lessons, research and editable roadmap. Align `CodemmApi` with it when it lands. The type names here are a first cut.

## Decisions

- **No syntax highlighting.** The editor is a plain textarea with line numbers and a line marker, so nothing dispatches on a language.
- **Generic colors.** Emm's and the course badges' colors are picked from the characters of a name (`ui/palette.ts`), never from what the name means.
- **Bundled fonts.** Fonts come from `@fontsource` (OFL), so the app needs no network and the CSP allows only `'self'`.
- **Drag is optional.** Course topics can be dragged, and each has a Move menu (Move up / Move down) as the non-drag alternative.
- **Unsigned builds.** macOS sets `identity: null` and `notarize: false`, and CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- **Linux sandbox.** The AppImage drops electron-builder's default `--no-sandbox`, so Chromium's sandbox stays on. electron-builder's launcher still adds `--no-sandbox` where unprivileged user namespaces are blocked (for example Ubuntu 24.04 without an AppArmor profile), because Chromium can't start sandboxed there from an AppImage. The deb installs the setuid `chrome-sandbox`, so it stays sandboxed everywhere. Prefer the deb on those systems.

## Verified

- `npm run typecheck` and `npm test` pass (60 tests).
- `npm run test:smoke` passes locally on macOS. It runs with reduced motion and saves a screenshot of every step to `test-results/`.
- `electron-builder --mac --arm64` built the `.app` locally. The dmg step needs `hdiutil`, which this sandbox blocks, so the dmg itself is verified in CI.

## Review

Astra (gpt-6-astra) reviewed the first commit. All seven findings are fixed:
- the AppImage default `--no-sandbox`;
- drafts lost on navigation (now `saveFiles`);
- a mock note that hinted at the answer;
- re-passing a mastered topic advancing the course;
- Try again after an infrastructure failure on Try it running a graded Check;
- no focus ring on the editor;
- the Assist switch's hit area below 32px.

## Next

- Wire in the real core adapter (above), and persist the current course and route.
- Real agent connection and research, once the desktop spec defines the bridge.
- Signing and notarization when there is an identity, behind secrets.
