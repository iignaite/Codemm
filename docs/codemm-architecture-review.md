# Codemm Architecture Review

Date: 2026-07-09
Scope: full-repo read-only audit (engineering, product, pedagogy, UX/design, local-first/privacy, AI/LLM, security, packaging, maintainability) followed by an incremental improvement plan.
Method: every claim below cites a file (and line where useful) in this repo. Line numbers are as of commit `c6cd095`.

---

## 1. Executive verdict

**Codemm today is an activity generator with a Docker grader. It is not a tutor, and it is not a learning-path engine.**

The repo says so itself: *"Codemm is an AI agent that turns a short chat into verified programming activities (problems + tests) and grades solutions in Docker sandboxes"* (`README.md:3`). Everything downstream is consistent with that sentence and inconsistent with the stated product goal of a learning system:

- The thread lifecycle is `DRAFT → CLARIFYING → READY → GENERATING → SAVED/FAILED` and **`SAVED` is terminal** (`apps/backend/src/contracts/session.ts:60-68`). There is no state for practicing, being evaluated, mastering, or continuing.
- The entire durable schema is `threads`, `thread_collectors`, `thread_messages`, `activities`, `submissions`, `runs`, `run_events` (`apps/backend/src/database/migrations.ts`). **No learner, no mastery, no concept, no path, no module, no progress table exists.**
- Submissions are write-and-forget: `judge.submit` persists pass/fail counts (`apps/backend/src/ipc/judge.ts:257-271`) and *nothing ever reads them back* to update any model of the learner. `submissionRepository` has exactly two methods: `create` and `findByActivityAndProblem` (`apps/backend/src/database/repositories/activityRepository.ts:116-150`).
- The one pedagogy input that exists — `LearnerProfile` with `concept_mastery` (`apps/backend/src/contracts/learnerProfile.ts:17-29`) — is a **facade**. Its DB accessor is a gravestone: `learnerProfileDb = undefined as never` with the comment `// removed (SaaS/user-account concept)` (`apps/backend/src/database.ts:35-40`), and its only consumer is always called with `learnerProfile: null` (`apps/backend/src/services/threads/threadGenerationService.ts:83,371`), so "average mastery" is the constant `0.5` (`apps/backend/src/planner/pedagogy.ts:35-44`).

**The main architecture/product mismatch:** the codebase invests heavily (and mostly well) in the *supply side* — generating and verifying activities — and invests nothing in the *demand side* — modeling the learner the activities are for. The generation pipeline has staged orchestration, retry policies, diagnostics, run logs, and per-role LLM routing; the learner has zero persisted bytes.

**What must change first:** a persisted local learner model (profile + per-concept mastery), updated deterministically from judge results, and a `LearningPath` structure that consumes it. Until those exist, every other improvement (UX, routing, packaging) polishes an activity generator. The good news: the seams already exist — `buildGuidedPedagogyPolicy` already accepts a learner profile (`planner/pedagogy.ts:46-65`); it has just never been fed.

Secondary verdict on Ollama: local-model support is **infrastructure done well but over-weighted relative to the product**. `apps/ide/localLlm/` is a full lifecycle manager (install/start/pull/probe/lease state machine, `apps/ide/localLlm/orchestrator.js:14-25`) — more engineering than the entire learner model, which does not exist. Ollama is an inference fallback, not the product.

---

## 2. Evidence from the repo

### 2.1 What exists and works

| Area | Evidence |
| --- | --- |
| Contract-first boundaries | `packages/shared-contracts/src/*` is the single DTO source; backend re-exports and adds Zod (`apps/backend/src/contracts/*`). No back-imports (clean layering). |
| Staged generation pipeline | skeleton → tests → reference → validate → repair stages (`apps/backend/src/pipeline/slotStages.ts:414-608`), retry policy (`pipeline/retryPolicy.ts`), rich diagnostics contracts (`packages/shared-contracts/src/generation.ts`). |
| Deterministic verification | Reference solutions are executed in Docker before an activity is accepted (`generation/referenceSolutionValidator.ts:37-46`); grading is test-count arithmetic, never an LLM (`ipc/judge.ts:143,260-270`). |
| IPC-only engine | No HTTP server in `apps/backend/src` (entry `ipcServer.ts`; hand-rolled JSON-RPC over `process.on("message")`). UI reaches it only through the preload allowlist (`apps/ide/preload.js:30-125`). |
| Local secrets | API keys encrypted via Electron `safeStorage`, never sent to the renderer, redacted in logs (`apps/ide/main.js:222-262,69-79`; `apps/backend/src/infra/observability/logger.ts:22-27`). |
| Uniform language plugins | `languages/{java,python,cpp,sql}/` each with `{adapters,judge,profile,prompts,rules,run}` — the best-factored subsystem in the repo. |
| Local LLM lifecycle | Explicit state machine `NOT_INSTALLED → … → READY` with persisted state and leases (`apps/ide/localLlm/orchestrator.js:14-25,83-125,298-315`); host capability probe (`hostCapabilityProbe.js:30`); RAM-gated model catalog (`modelCatalog.js:36-61`). |

### 2.2 What is claimed but absent

| Claim / goal | Reality |
| --- | --- |
| "Learning system" | No `LearningPath`, `Module`, `Lesson`, `Concept`, `Skill`, `Prerequisite`, `Mastery`, or `Progress` type or table anywhere (repo-wide grep: 0 hits). Concepts exist only as free-text `topic_tags: string[]` (`contracts/activitySpec.ts:63`). |
| Learner diagnosis / remediation | All `diagnos*`/`remediation` hits are about **generation failures**, not learners (`contracts/generationDiagnostics.ts`; `generation/validationService.ts:27` returns hints like "Regenerate this slot" — advice to the generator). |
| Adaptive difficulty | `DifficultyPlan` is a static author-requested easy/medium/hard mix (`contracts/activitySpec.ts:19-49`). Guided mode's scaffold curve is hardcoded by problem index: `[80,60,30,10]` (`planner/pedagogy.ts:27-33`). Nothing adapts to the learner. |
| Cloud→local fallback | Provider choice is a one-time settings decision. At runtime a failing provider **re-throws**; there is no automatic cloud↔local switch (`apps/ide/main.js:1017-1030`; `infra/llm/codemmProvider.ts:104` picks exactly one provider). |
| Shareable activities | Review page says "Published. You can share the link now" (`apps/frontend/src/app/activity/[id]/review/page.tsx:165`) but the URL is `http://127.0.0.1:<ephemeral-port>/...` guarded by a per-session boot token — meaningless outside this machine. |

---

## 3. Multi-perspective verdict

### Engineering
Boundaries are **clean at the process level** (Electron main / engine child / frontend / Docker) and **tangled inside the backend**: `generation/` and `pipeline/` are mutually dependent (`generation/orchestrator.ts:13` imports pipeline; `pipeline/slotStages.ts:22-29` imports generation validators back) — one subsystem split across two folders. `apps/ide/main.js` is a 1,726-line god-file mixing boot, secrets, port logic, ~240 lines of inline splash HTML (`main.js:1176-1415`) and ~200 lines of LLM route-plan construction (`main.js:867-1082`). The largest single item: a **1,824-line legacy generator (`generation/perSlotGenerator.ts`) reachable only from unit tests** — production never sets the `deps.generateSingleProblem` flag that activates it (`orchestrator.ts:250`; `threadGenerationService.ts:153-161` passes no deps). ~13% of the backend kept alive purely as test scaffolding.

### Product
Activity-generator-first, by design and by evidence (§1). Of the six stated workflows — diagnose, create path, practice, evaluate, update mastery, continue — only **practice** (partially: `judge.run`) and **evaluate** (`judge.submit`) exist. The IPC surface (`apps/ide/preload.js:32-123`) serves authoring and grading exclusively.

### Pedagogy
Types exist without behavior. `LearnerProfile`/`concept_mastery`/`recent_failures` (`contracts/learnerProfile.ts`) are never populated; `PedagogyPolicy` (`planner/pedagogy.ts:13-20`) degrades to a fixed curve; no prerequisites, no spaced repetition, no mastery-vs-completion distinction. Codemm cannot tell a learner who has passed 50 problems apart from one who just installed the app.

### UX / design
The practice IDE (`apps/frontend/src/app/activity/[id]/page.tsx`) is solid. But the app's worst UX bug is on the default path: **a first-run user with no LLM configured can chat immediately, and their first message fails with "Sorry, something went wrong processing your answer. Please try again in the expected format."** (`apps/frontend/src/hooks/useThread.ts:301-310`, triggered by `throw new Error("No LLM configured.")` at `apps/ide/main.js:972`). The copy blames the user's input; nothing points to LLM Settings. The onboarding tour (`app/page.tsx:11-36`) never mentions key/model setup. No progress, path, or skill-gap UI exists anywhere; per-problem pass state lives in `localStorage` per activity (`hooks/useActivity.ts:82,144,545`). `/chat` is a dead duplicate of Home (`app/chat/page.tsx:1`).

### Local-first / privacy
Strong. No accounts, no telemetry endpoints, IPC-only engine, safeStorage secrets, per-workspace SQLite (`database/db.ts:54-84`). Remaining vestiges are inert shapes: `LearnerProfile.user_id` (`contracts/learnerProfile.ts:19`), the `sessions`→`threads` rename shims (`migrations.ts:16-46`), `DBSession*` type names (`database/repositories/threadRepository.ts`), and the misleading "share link" copy (§2.2).

### AI / LLM
Better than typical: role-based routing (`LlmRole`, 7 roles, `packages/shared-contracts/src/llm.ts:3`), capability escalation via `fallbackChain` (`infra/plugins/runtime/index.ts:97-111`), centralized layered JSON repair (`utils/jsonParser.ts:8-54`), and the LLM is *never* used for grading or mastery. Gaps: (a) **no automatic cross-provider fallback** (§2.2); (b) `inferCapability` duplicated in TS and JS with divergent logic — a `:32b` model is `strong` to the backend (`infra/plugins/runtime/index.ts:30-32`) and `balanced` to the IDE (`apps/ide/main.js:888-900`); (c) Gemini is special-cased in ≥6 branches instead of being a `ProviderPlugin` (`infra/llm/codemmProvider.ts:29,43,67,91,125-135`; registry at `infra/plugins/provider/index.ts:7` excludes it); (d) weak-machine gating uses total RAM only — `freeRamGb` is probed but unused (`modelCatalog.js:55`) — and no `num_ctx` cap exists (`adapters/ollama.ts:82-90`), so big prompts can OOM small local models; (e) stale defaults (`claude-3-5-sonnet-latest`, `adapters/anthropic.ts:3`; `gemini-1.5-pro`, `adapters/gemini.ts:5`); (f) the `wording` role is declared but unwired (`llm.ts:3` vs `main.js:875`).

### Security
Good architecture, two high-severity sandbox gaps:
1. **No resource limits on judge containers.** Every runner sets only `--network none --read-only --rm --tmpfs` (e.g. `languages/python/judge.ts:60-81`; same in java/cpp/sql). No `--memory`, `--cpus`, `--pids-limit`, no tmpfs size cap. A fork bomb or memory balloon freezes the host inside the 15s timeout window.
2. **Learner code runs as root** — no `USER` in any `Dockerfile.*-judge`, no `--user`, `--cap-drop`, or `no-new-privileges` in any run argv.
Also: Java mounts the workspace read-write (`languages/java/judge.ts:53-54,121-122`) unlike python/cpp/sql (`:ro`), and the renderer has no CSP while displaying LLM-generated content with a privileged `window.codemm` bridge.
Done well: no listening backend port at all (DNS-rebinding structurally impossible), loopback+token-verified frontend (`main.js:302-349`), `contextIsolation`/`nodeIntegration` correct (`main.js:1094-1098`), all spawns use array args (no `shell:true`), path-traversal checks on judge file writes (`judge/files.ts:4-33`).

### Packaging / operations / adoption
Docker Desktop is a hard boot gate — missing or stopped Docker means a dialog and `app.quit()` (`apps/ide/main.js:788-817`) — and first launch builds **four** judge images (`main.js:728,1461`): multi-GB network downloads before the user sees anything. The only documented install path is clone + `npm install` (`README.md:76-96`). `better-sqlite3` ABI rebuilds are a known break point (`docs/TROUBLESHOOTING.md:113-134`). Sub-6GB machines are not hard-blocked from local models; the catalog "tries the smallest anyway" (`modelCatalog.js:60-61`) and fails late.

### Maintainability
See the complexity table (§4). Headline: ~2,000 LOC of test-only legacy generation, a half-finished provider-plugin migration, a single-element plugin registry (`infra/plugins/runtime/index.ts:115-123`), a generic `ExecutionEngine` used only for fixed linear sequences (`engine/execution/*`; used at `orchestrator.ts:270-290` and `threadGenerationService.ts:87-300` with no skip/branch/recovery), 33 bare `catch {}` blocks (most benign, but `ipc/threads.ts:51-81` silently drops run-event persistence failures and `database/db.ts:44` can hide a corrupt-DB condition), and 704 lines of Java-specific code under generic `utils/` (`utils/javaSource.ts`).

---

## 4. Required vs removable complexity

| Area / file | Current complexity | Classification | Recommended action | Risk if changed | Safer incremental refactor |
| --- | --- | --- | --- | --- | --- |
| `generation/perSlotGenerator.ts` (1,824 LOC) + `legacyAdapter.ts` + `useLegacyAdapter` plumbing in `orchestrator.ts:82-88,122-166,250,284` | Parallel legacy generator, production-unreachable | Legacy leftover | Delete after porting its 5 unit tests to the staged-pipeline stub (`test/helpers/installGenerationStub.js`) | Medium — tests pin behavior nothing runs | Port tests one at a time, then delete in one commit |
| `contracts/learnerProfile.ts` + always-`null` threading (`threadGenerationService.ts:83,371`) + `database.ts:35-40` gravestones | Dead SaaS-shaped learner model | Legacy leftover | **Do not just delete — replace.** Redefine as `LocalLearnerProfile` (no `user_id`) and actually persist/feed it (Phase 2) | Low | Land new contract + persistence first, then remove old shape |
| Gemini special-casing in `codemmProvider.ts` (≥6 branches) | Half-finished plugin migration | Legacy leftover | Implement `geminiProviderPlugin`, register it, delete branches | Medium — provider selection; covered by `codemmProvider.test.js` | Add plugin alongside branches, switch, delete |
| `createCodexCompletion`/`getCodexClient` aliases (`codemmProvider.ts:155-159`) | Back-compat aliases, one in-repo user (test helper) | Legacy leftover | Rename caller, delete aliases | Low | — |
| `inferCapability` ×3 (`infra/plugins/runtime/index.ts:17-34` incl. internal duplication; `apps/ide/main.js:888-900`) | Divergent duplicated heuristic | Bloat | Single source of truth; IDE consumes backend's resolution or a shared table | Medium (two processes) | First dedupe within backend; then align IDE copy to same table |
| `infra/plugins/runtime` registry (1 plugin) + `runtimeService.ts` forwarding | Speculative generality | Bloat | Collapse to plain functions | Low | — |
| `generation/services/scaffoldingService.ts` (1-line re-export; callers disagree on which door: `orchestrator.ts:12` vs `slotStages.ts:24`) | Shim indirection | Bloat | Delete; import `scaffolding` directly | Low | — |
| `engine/execution/*` (~180 LOC generic state machine) | Generic engine for two fixed linear sequences | Unclear → bloat | Keep only if branching/skip appears; otherwise inline as awaited calls, preserving observability events (`ExecutionEngine.ts:38-84`) | Low-medium | Leave until Phase 8; do not entangle with learner work |
| `threads.generate` vs `threads.generateV2` (`ipc/threads.ts:238-264`, identical handler, only `meta.mode` differs) | False duplication | Legacy leftover | Collapse after confirming frontend caller | Low | Alias one to the other first |
| `sessions`→`threads` rename shims (`migrations.ts:16-46`), `DBSession*` names, `services/sessionService.ts` facade | In-flight rename debt | Legacy leftover | Keep DB rename shims (real user DBs may predate rename); finish type/file renames | Low (types), medium (migrations) | Rename types only; never touch migration shims without a versioned migration story |
| `apps/ide/main.js` splash HTML (`:1176-1415`), route-plan block (`:867-1082`), `__codemmSplashUpdate` back-compat shapes (`:1393-1404`) | God-file | Bloat | Extract to files; delete unused patch shapes | Low | Pure moves, zero behavior change |
| `utils/javaSource.ts` (704 LOC) | Misplaced language logic | Unclear (required logic, wrong home) | Move under `languages/java/` | Low | — |
| Legacy problem shapes (`contracts/problem.ts:247-324`, `types.ts:20-29`) | Old-activity parsing + LLM contract | Required complexity | Keep; document cutoff | — | — |
| Staged pipeline, retry policy, diagnostics, run-event log | High but earns its keep | Required complexity | Keep | — | — |
| Local LLM orchestrator state machine (`apps/ide/localLlm/*`) | High | Required complexity | Keep; fix gating gaps (free RAM, `num_ctx`) | — | — |
| Bare `catch {}` on persistence (`ipc/threads.ts:51-81`, `database/db.ts:44`, `generation/progressBus.ts:56`) | Silent failure swallowing | Bloat (anti-pattern) | Log via existing `infra/observability/logger`; DB-init failures should be loud | Low | — |

---

## 5. Product-model gaps

1. **ActivitySpec is author-centric.** It captures what to generate (`languages`, `topic_tags`, `difficulty_plan`, `problem_count` — `contracts/activitySpec.ts:51-117`) but nothing about *why this learner, now*: no source path/lesson, no target concepts with IDs, no mastery context.
2. **No LearningPath model.** Zero types, tables, or channels for path/module/lesson. The Activities screen is a flat creation-ordered list (`app/activities/page.tsx`).
3. **No local learner profile or mastery persistence.** The only learner shape is the dead SaaS one (§1). Nothing distinguishes completion from mastery; `submissions` rows are never aggregated.
4. **No concept/prerequisite/remediation/progression model.** Concepts are free-text tags; there is no graph, no "you should review X before Y," no failure-pattern tracking (`recent_failures` exists as a dead type only), no spaced repetition.
5. **Lifecycle stops at generation.** `SAVED` is terminal (`contracts/session.ts:60-68`); practicing/evaluating happen *outside* any modeled journey.

## 6. Local LLM / Ollama gaps

1. **Routing**: capability model exists but is split-brain across backend TS and IDE JS (§3 AI/LLM b); Gemini outside the registry (c); `wording` role unwired (f).
2. **Weak-machine fallback**: total-RAM-only gating, unused `freeRamGb`, no `num_ctx` cap, no hard floor for sub-6GB machines (`modelCatalog.js:55-61`; `adapters/ollama.ts:82-90`).
3. **Capability honesty**: roles are routed by size heuristic, but nothing tells the *user* that a 1.5b local model cannot reliably do planning/test-generation. There is no per-role "local model not recommended" surface, and no automatic cloud↔local degradation (`main.js:1017-1030`).
4. **Local vs cloud role split (recommendation)**: `dialogue`, `wording`, `edit` are viable on balanced local models; `skeleton`/`tests`/`reference`/`repair` should prefer the strongest available route and warn when only a weak local model exists. Learning-path *planning* (once it exists) should be deterministic-first with LLM assistance, never weak-local-only.

## 7. UX and packaging gaps

1. **First-run failure is misleading** — the no-LLM-configured error blames the user's input format (`useThread.ts:301-310`). Highest-impact single fix in the repo.
2. **Setup is undiscoverable** — no gate/banner/tour step routes users to LLM Settings before their first message (`app/page.tsx:11-36`).
3. **Docker is a fatal boot gate with a multi-GB first launch** (`main.js:788-817,1461`) and no degraded mode (e.g., browse/author without judging).
4. **No learning-state UI** — no progress, next-step, gap, or path view; per-activity localStorage pass-dots only.
5. **Install story is developer-only** (`README.md:76-96`); ABI rebuild fragility; hardcoded Docker paths with escaping oddities on Windows (`main.js:389`).
6. **Misleading copy**: "share the link" on a localhost-token URL (`review/page.tsx:103-107,165`); stale env-var instructions in an engine error (`infra/llm/codemmProvider.ts:114`); `ARCHITECTURE.md:23,26` describes `fork` and a fixed port 3000, but code uses `spawn` + `ELECTRON_RUN_AS_NODE` (`main.js:503-537`) and an ephemeral-port fallback (`main.js:614-657`).

---

## 8. Refactor plan (incremental, behavior-preserving unless stated)

**Phase 1 — Terminology and domain model.**
Finish the sessions→threads rename at the type level (`DBSession*` → `DBThread*`; retire `services/sessionService.ts` facade); replace the SaaS `LearnerProfile` contract with a local-first `LocalLearnerProfile` (no `user_id`); remove `userDb`/`learnerProfileDb` gravestones. Keep DB-level rename shims untouched.

**Phase 2 — Local learner profile and mastery persistence.**
New tables: `learner_profile` (singleton per workspace DB), `concept_mastery` (concept id → mastery 0..1, attempt counts, last-seen), optionally `attempts` view over `submissions`. Workspace-owned data stays in the workspace DB (`<workspace>/.codemm/codemm.db`); machine/app prefs stay in Electron userData. New repositories mirroring the existing pattern (`database/repositories/*`).

**Phase 3 — Learning path contracts/tables/services.**
Contracts: `LearningPath`, `PathModule`, `PathLesson` (concept ids + prerequisite edges + target mastery), `MasterySnapshot`. Tables + repository + IPC channels (`learning:getPath`, `learning:getProgress`, …) following the `{schema, handler}` map pattern in `ipc/*`.

**Phase 4 — Attempts/submissions connected to mastery updates.**
On `judge.submit`, derive concept ids from the problem's topic tags and apply a **pure, deterministic** mastery-update function (e.g. bounded exponential moving average with pass/fail evidence weights). The LLM never decides mastery. Unit-test the progression function exhaustively.

**Phase 5 — Capability-based model routing.**
Single capability table shared between backend and IDE; register Gemini as a `ProviderPlugin` and delete special cases; delete `createCodex*` aliases; wire or remove the `wording` role; add free-RAM + `num_ctx` guards; surface per-role "not recommended on this model" to the UI. (Automatic cloud↔local runtime fallback is a product decision — see §10.)

**Phase 6 — Packaging/startup UX cleanup.**
Fix the misleading no-LLM error into an actionable "Configure a model" message + Settings link; add an LLM-configured status check on Home; add a setup step to the onboarding tour; fix "share link" copy; correct stale docs (`ARCHITECTURE.md` boot description, `codemmProvider.ts:114` error text).

**Phase 7 — Remove legacy leftovers.**
Delete `perSlotGenerator.ts`/`legacyAdapter.ts` after porting tests; collapse `generate`/`generateV2`; delete the scaffolding shim, single-element runtime registry, splash back-compat shapes; move `javaSource.ts` under `languages/java/`.

**Phase 8 — Simplify bloated orchestration into declarative pipelines.**
Express the thread lifecycle as an explicit transition table (states already exist in `contracts/session.ts:60`); replace the hand-rolled soft-fallback `while` loop in `generateFromThread` (`threadGenerationService.ts:151-243`) with the existing `pipeline/retryPolicy.ts`; make provider resolution a descriptor-table iteration; reconsider `engine/execution/*` once call sites are linear calls. Make persistence-failure `catch {}` blocks log loudly.

**Phase 9 — Frontend learning-path UX.**
A path/progress view (modules → lessons → activities with mastery per concept), "continue where you left off" on Home, and skill-gap surfacing — driven entirely by the deterministic local state from Phases 2–4.

Security fixes are orthogonal to the phases and should land immediately (they *increase* isolation): resource limits + non-root + cap-drop on all judge containers; Java workspace mount to `:ro` with compile output redirected to tmpfs; renderer CSP.

---

## 9. Validation status of this review

All file/line citations were produced against commit `c6cd095` by direct inspection. Claims about reachability (e.g. `perSlotGenerator` being test-only, `learnerProfile` always `null`) were verified by tracing call sites, not by grep alone.

## 10. Open product decisions (do not implement without a decision)

1. **Automatic cloud↔local runtime fallback** — silently switching providers mid-run changes cost/privacy expectations. Recommend: explicit user-visible degradation prompt, not silent switching.
2. **Docker-optional mode** — allowing authoring/browsing without Docker changes the "everything is verified" invariant. Recommend: keep verification mandatory for *publishing*, allow browsing/setup without Docker.
3. **Concept taxonomy** — free-text tags vs curated per-language concept lists. Mastery persistence (Phase 2) can start tag-keyed and migrate to curated ids later, but the choice affects path quality.
4. **`ThreadLearningMode` future** — `practice`/`guided` may become properties of a path lesson rather than a thread. Defer renaming until the path model lands.

---

## 11. Status of landed changes (2026-07-09)

The first tranche of the plan has landed on `main`:

- **Phase 1–2 (learner model)**: `LocalLearnerProfile`/`ConceptMastery`/`MasterySnapshot` contracts replace the dead SaaS `LearnerProfile`; `learner_profile` + `concept_mastery` tables and repositories persist learner state in the workspace DB; a pure, deterministic mastery module (`src/learning/mastery.ts`) folds every graded `judge.submit` into per-concept mastery; guided generation consumes the real mastery snapshot; `learning.*` IPC channels expose profile and mastery to the UI.
- **Phase 5 (routing, partial)**: one capability module per process with a parity test; Gemini registered as a `ProviderPlugin` and all special cases removed; provider resolution is registry iteration + an explicit-provider error table; `wording` role wired into IDE route plans.
- **Phase 6 (partial)**: no-LLM first-run errors now point to LLM Settings; onboarding tour gained a model-setup step; stale env-var error text, `fork`/fixed-port boot description, and "share link" copy corrected.
- **Phase 7 (partial)**: `scaffoldingService` shim, `createCodex*` aliases, and the duplicate `threads.generateV2` method deleted.
- **Security**: judge containers now run with `--pids-limit`, `--memory`, `--memory-swap`, `--cpus`, `no-new-privileges`, and sized tmpfs mounts, injected at the `runDocker` choke point.

Still open (in priority order): non-root judge containers + `--cap-drop` (needs verification on a machine with Docker; interacts with host-mount permissions), deleting `perSlotGenerator.ts`/`legacyAdapter.ts` after porting its five tests, the `LearningPath`/`PathModule`/`PathLesson` contracts and UI (Phases 3, 9), free-RAM/`num_ctx` guards for local models, and the Phase 8 orchestration simplifications.

## 12. Blunt final recommendation

Codemm is a well-engineered **activity generator** wearing a learning-system mission statement. The single most important gap is not code quality — it is that **the learner does not exist in the data model**. Fix that first (Phases 1–4), with deterministic mastery updates and workspace-local persistence, before investing further in generation sophistication or local-model orchestration. Ollama support is currently over-weighted relative to the product: it is an inference fallback and should stay one. The security posture is close to right and needs the cheap container-hardening flags now.
