# Codemm Architectural Audit

Date: 2026-04-05
Branch: `audit/architecture-full`
Scope: `apps/ide`, `apps/backend/src`, `apps/frontend/src`, root docs, app-local docs

This audit is source-first. Conclusions are grounded in current files, imports, runtime entrypoints, and active documentation. Generated outputs such as `apps/backend/dist` and `apps/frontend/.next` are ignored as primary architecture surface because they are untracked build artifacts.

The repository still expresses a sensible intended architecture:

- `apps/ide` should own Electron boot, window security, workspace selection, secrets, and the preload bridge.
- `apps/backend` should own deterministic orchestration, persistence, Docker judging, and model execution.
- `apps/frontend` should stay a renderer UI that consumes stable engine contracts.

That intent is still visible in the root docs and top-level folder layout, but several high-traffic implementation files have drifted into boundary-heavy coordinator objects that know too much about adjacent layers.

## 1. Key Findings (Top Issues)

1. **Boundary collapse in the main coordinators is the primary maintainability risk.**
   Fact: [`apps/ide/main.js`](../../apps/ide/main.js) contains Electron boot, workspace selection, secrets, route-plan construction, local Ollama lifecycle, Docker readiness, engine IPC bridging, and renderer boot in one file, with `createWindowAndBoot()` alone spanning roughly lines 760-1450. [`apps/backend/src/ipcServer.ts`](../../apps/backend/src/ipcServer.ts) combines transport, validation, run tracking, activity APIs, and judge APIs. [`apps/backend/src/services/sessionService.ts`](../../apps/backend/src/services/sessionService.ts) combines thread state machine logic, persistence, dialogue parsing, confirmation flow, generation dispatch, and recovery.
   Observation: Codemm has separate folders for UI, engine, and infra, but the dominant runtime path is still controlled by a small number of god coordinators.
   Recommendation: Keep the existing architecture, but split these files into thin facades over dedicated boot, contract, orchestration, and infra modules.

2. **Generation has architecture drift between the new staged pipeline and the legacy all-in-one generator.**
   Fact: [`apps/backend/src/generation/index.ts`](../../apps/backend/src/generation/index.ts) imports both `runSlotPipeline(...)` and the legacy `generateSingleProblem(...)` / `validateReferenceSolution(...)` path, then decides between them inside `generateProblemsFromPlan()` around lines 210-444. [`apps/backend/src/generation/perSlotGenerator.ts`](../../apps/backend/src/generation/perSlotGenerator.ts) remains a 1,824-line legacy generator with prompt construction, parsing, normalization, repair, and language-specific branches.
   Observation: The new staged pipeline is real, but it is not yet the sole generation model. The old path still shapes retry semantics, validation assumptions, and test seams.
   Recommendation: Move to one production generation path, with a compatibility adapter kept only for tests or narrow fallback scenarios.

3. **Renderer/backend contracts are duplicated instead of being owned once.**
   Fact: [`apps/backend/src/contracts/generationProgress.ts`](../../apps/backend/src/contracts/generationProgress.ts) and [`apps/frontend/src/types/generationProgress.ts`](../../apps/frontend/src/types/generationProgress.ts) mirror the same event model. [`apps/frontend/src/app/settings/llm/page.tsx`](../../apps/frontend/src/app/settings/llm/page.tsx) redefines route-plan and runtime status types locally instead of importing a shared contract. [`apps/frontend/src/app/page.tsx`](../../apps/frontend/src/app/page.tsx) also carries local versions of thread and diagnostics payload shapes.
   Observation: The codebase is nominally contract-first, but the actual contract boundary is split across multiple files and layers.
   Recommendation: Promote IPC payloads, generation events, and LLM route-plan shapes into a shared contract package or generated shared module.

4. **The renderer is carrying application logic that the docs say should live in the engine.**
   Fact: [`apps/frontend/src/app/page.tsx`](../../apps/frontend/src/app/page.tsx) is a 1,642-line route component that owns thread bootstrapping, local persistence, diagnostics refresh, progress-event reduction, generation UX state, and navigation decisions. [`apps/frontend/src/app/activity/[id]/page.tsx`](../../apps/frontend/src/app/activity/[id]/page.tsx) is an 875-line route component that owns workspace reconstruction, timer persistence, file editing state, run/submit orchestration, and layout persistence.
   Observation: The renderer is not just rendering engine state. It is acting as a second orchestration layer.
   Recommendation: Move route-level orchestration into dedicated hooks, reducers, and bridge client modules so route components become view composition files again.

5. **Electron main owns too much backend and provider knowledge.**
   Fact: [`apps/ide/main.js`](../../apps/ide/main.js) handles encrypted secrets, provider activation, local runtime readiness, route-plan selection, engine method dispatch, and many `codemm:*` handlers directly. [`apps/ide/localLlm/orchestrator.js`](../../apps/ide/localLlm/orchestrator.js) is cohesive, but it is explicitly Ollama-specific through `ollamaRuntimeDriver`.
   Observation: The local-runtime story is useful, but the abstraction is “Ollama-in-main” rather than “local provider runtime behind an adapter.”
   Recommendation: Keep the local-first behavior, but define a provider/runtime interface and make Electron main depend on that interface instead of Ollama details.

6. **Persistence and naming still reflect legacy “session” concepts even though the product surface is now “threads.”**
   Fact: [`apps/backend/src/database.ts`](../../apps/backend/src/database.ts) still exports `DBSession`, `DBSessionSummary`, `DBSessionMessage`, and `DBSessionCollector`, while the IPC surface and frontend talk about threads. The same file also owns migrations and every DAO.
   Observation: This is not just cosmetic. It increases translation work across layers and hides ownership of the thread lifecycle.
   Recommendation: Split migrations from repositories, then align naming on one concept at the application boundary even if table names stay stable initially.

7. **The docs are split between current root docs and stale app-local docs from the old HTTP/auth product shape.**
   Fact: Root docs describe the Electron + IPC + local-only architecture accurately. Many app-local docs still describe Express routes, SSE, auth, profiles, and community endpoints. Examples: [`apps/backend/docs/architecture.md`](../../apps/backend/docs/architecture.md) lines 13-23, [`apps/backend/docs/data-flow.md`](../../apps/backend/docs/data-flow.md) lines 7, 45, 67, 96, [`apps/frontend/docs/pipelines/generation.md`](../../apps/frontend/docs/pipelines/generation.md) lines 7-9, and [`apps/frontend/docs/agentic-design/tools-and-actions.md`](../../apps/frontend/docs/agentic-design/tools-and-actions.md) lines 9-56.
   Observation: Contributors can read two contradictory architectures inside the same repo.
   Recommendation: Treat root docs as canonical, deprecate stale app-local docs immediately, and rebuild only the app docs that still add value.

8. **There is at least one real import cycle in the agent layer.**
   Fact: A repository-wide relative-import sweep over 127 `.ts` / `.tsx` / `.js` files found one direct cycle: [`apps/backend/src/agent/commitments.ts`](../../apps/backend/src/agent/commitments.ts) imports `REQUIRED_CONFIDENCE` from [`apps/backend/src/agent/readiness.ts`](../../apps/backend/src/agent/readiness.ts), while `readiness.ts` imports `CommitmentStore` from `commitments.ts`.
   Observation: The current cycle is small and low-risk, but it is a concrete example of policy and state representation bleeding together.
   Recommendation: Move readiness thresholds into a third policy module that both files consume.

## 2. File-Level Problems

### Electron / IDE

| File or group | Responsibility today | Finding | Why it matters |
| --- | --- | --- | --- |
| `apps/ide/main.js` | Electron entrypoint, window security, workspace setup, secrets, local runtime, route-plan shaping, IPC registration, backend child boot | God file and mixed-responsibility coordinator. It owns UI boot, provider selection, infra lifecycle, and engine transport in one place. | Hard to change any one concern without regression risk in adjacent concerns. It is also where architecture drift accumulates first. |
| `apps/ide/preload.js` | Preload allowlist for `window.codemm.*` | Mostly healthy. Clear boundary, but it inherits a very wide surface because `main.js` exposes many concerns directly. | The file itself is not the problem; the breadth of bridged methods reflects missing service boundaries behind it. |
| `apps/ide/localLlm/orchestrator.js` | Local runtime state machine and lease management | Cohesive internally, but the abstraction is provider-specific. “Local runtime orchestration” is effectively “Ollama orchestration.” | This blocks clean expansion to other local backends or multiple runtime drivers. |
| `apps/ide/localLlm/ollamaRuntimeDriver.js` and sibling files | Host probing, model catalog, Ollama process control | Good infra isolation overall. The problem is placement and ownership, not the individual files. | These files are strong candidates to become the first provider adapter boundary rather than being pulled deeper into `main.js`. |

### Backend orchestration and persistence

| File or group | Responsibility today | Finding | Why it matters |
| --- | --- | --- | --- |
| `apps/backend/src/ipcServer.ts` | RPC transport, request validation, method dispatch, generation subscription, run tracking, activity APIs, judge APIs | Mixed transport and application orchestration. The handler map starting at line 183 knows too much about thread, activity, run, and judge internals. | The engine’s public contract is IPC-only, so this file is effectively the engine boundary. It should be thin and boring, but it currently contains domain-aware coordination. |
| `apps/backend/src/services/sessionService.ts` | Thread lifecycle, chat loop, confirmation flow, persistence, generation dispatch, checkpoint recovery, slot regeneration | God service. `processSessionMessage()` and `generateFromSession()` each combine domain decisions, persistence, and runtime control flow. | This is the core application service, but it is too broad to evolve safely. It also hides the real thread state machine inside one large file. |
| `apps/backend/src/database.ts` | SQLite bootstrap, migrations, schema ownership, all repositories | Overloaded persistence module. Schema, migrations, and all DAO functions live together, and legacy “session” naming leaks everywhere. | Every persistence change touches the same file. It also obscures which repository owns which aggregate. |
| `apps/backend/src/services/activityProblemEditService.ts` | AI-assisted problem editing plus validation | Mixed orchestration and language-specific prompting. It rebuilds per-language prompt rules and invokes LLM + reference validation directly. | Problem editing is becoming its own application flow, but it currently duplicates generation-layer knowledge instead of reusing a shared editing contract. |
| `apps/backend/src/services/dialogueService.ts` | Dialogue parsing, deterministic fallback extraction, LLM call shaping | Mostly cohesive and a good candidate for a dedicated parser service. The main issue is that its output contract is not the only dialogue contract in practice because `sessionService.ts` still wraps and transforms it heavily. | This is one of the cleaner service files and should remain separate rather than being reabsorbed. |
| `apps/backend/src/services/confirmationFlow.ts` | Confirmation-field adjustment rules | Focused utility. Small and single-purpose. | Keep this style. It is the right level of isolation for deterministic policy helpers. |

### Backend domain, planning, and generation

| File or group | Responsibility today | Finding | Why it matters |
| --- | --- | --- | --- |
| `apps/backend/src/generation/index.ts` | Plan-to-problem orchestration, retries, progress shaping, legacy/new generator selection | Architecture drift hub. It brokers between the new staged pipeline and legacy generation path and still owns slot-domain seeding and result shaping. | This file is where “temporary compatibility” can quietly become permanent design debt. |
| `apps/backend/src/generation/perSlotGenerator.ts` | Legacy all-in-one per-slot generation, language-specific repair, normalization, prompting, sample/test shaping | God file. It mixes prompting, parsing, post-processing, language policy, retries, and repair strategy. | It is the single largest backend file and the hardest place to reason about correctness or reuse. |
| `apps/backend/src/pipeline/slotStages.ts` | New staged slot pipeline, stage execution, draft validation, failure classification | Better boundary than the legacy generator, but still imports generation/scaffolding logic and duplicates helper behavior such as style normalization and starter derivation. | This is the right target architecture, but it is not yet independent enough to replace the old path cleanly. |
| `apps/backend/src/pipeline/stages/*` | Stage-specific skeleton/tests/reference generation | Healthy direction. These files express a cleaner split than the legacy generator. | Preserve this structure and keep pulling behavior out of `perSlotGenerator.ts` into this layer. |
| `apps/backend/src/generation/scaffolding.ts` | Guided scaffolding derivation | Large but conceptually coherent. The main issue is location: it is both a generation post-process and a pedagogy policy implementation. | It should eventually sit behind a pedagogy/scaffolding service boundary, not inside generic generation. |
| `apps/backend/src/planner/*` | Deterministic plan derivation and pedagogy policy | Generally clean. [`apps/backend/src/planner/index.ts`](../../apps/backend/src/planner/index.ts) is a good example of bounded deterministic logic. | This is one of the clearest domain/core modules and should be a model for other layers. |
| `apps/backend/src/compiler/*` | Spec draft invariants and patch application | Generally clean, but fixed-field policy is still partly spread across compiler, dialogue, and session orchestration. | The compiler boundary exists, but some spec policy is still enforced outside it. |
| `apps/backend/src/contracts/*` | Engine contracts and schemas | Good backend source of truth, but not the actual repo-wide source of truth because the renderer mirrors several of these contracts separately. | Contracts should be shared, not copied. |
| `apps/backend/src/agent/*` | Dialogue/readiness/commitment policy helpers | Mostly cohesive leaf modules. The concrete issue is the `commitments.ts` ↔ `readiness.ts` cycle and the scattering of field policy across multiple small modules. | The agent layer is close to being a clean policy layer, but it needs one more pass on ownership. |

### Backend infrastructure

| File or group | Responsibility today | Finding | Why it matters |
| --- | --- | --- | --- |
| `apps/backend/src/infra/llm/adapters/*` | Provider-specific completion adapters | Mostly healthy. Clear infra adapters for Anthropic, Gemini, Ollama, and OpenAI. | This is the right direction for backend provider abstraction. The missing piece is that route-plan ownership is still split between backend and Electron main. |
| `apps/backend/src/infra/llm/routePlanner.ts` | Route-plan normalization, role routing, capability inference | Cohesive, but capability inference still bakes Ollama-specific model heuristics into a generic route planner. | Keep the module, but move provider-specific capability heuristics behind provider adapters or catalogs. |
| `apps/backend/src/judge/*` and `apps/backend/src/languages/*` | Docker invocation, temp files, language adapters, run/judge rules | Strongest architectural area in the repo. Responsibilities are mostly clear and infra-specific code stays in infra. | This is the best example of maintainable modularity in the backend and should not be rewritten. |
| `apps/backend/src/utils/*` | Small utilities plus Java helpers and tracing | Mixed bag. `jsonParser.ts`, `trace*.ts`, and Java source helpers are useful, but `utils` is starting to collect language-specific logic that may deserve domain placement. | Not a crisis, but it is an early warning for utility dumping-ground drift. |

### Frontend

| File or group | Responsibility today | Finding | Why it matters |
| --- | --- | --- | --- |
| `apps/frontend/src/app/page.tsx` | Thread screen, chat loop, progress rendering, diagnostics, local persistence, navigation | God route. It contains application logic, bridge shaping, progress reduction, and UI state in one file. | Any change to generation events or thread behavior forces edits in a route component instead of a dedicated UI state layer. |
| `apps/frontend/src/app/activity/[id]/page.tsx` | Solver/editor route, timer, workspace reconstruction, run/submit wiring, layout persistence | Mixed route and editor-runtime controller. It knows about persistence, file layout, bridge calls, and user interaction timing. | This is the renderer’s second major orchestration file and will keep growing as activity features expand. |
| `apps/frontend/src/app/settings/llm/page.tsx` | LLM settings UI, route-plan status loading, local runtime subscription, activation flows | Too much contract duplication and bridge-specific shaping inside a page file. | This page should render provider state, not define the provider contract. |
| `apps/frontend/src/app/activity/[id]/utils.ts` | Judge helpers, output parsing, language helpers, bridge wrappers | Hidden orchestration helper. It includes JUnit parsing, ANSI stripping, SQL test parsing, and bridge accessors. | The renderer is interpreting judge artifacts that should be normalized once in backend or shared contract code. |
| `apps/frontend/src/app/activity/[id]/components/*` | Pane components for the activity page | Good extraction for view composition, but they sit under a route whose real state management still lives in the parent page. | The component split is useful, but it has not yet produced a real state boundary. |
| `apps/frontend/src/lib/specBuilderUx.ts` and `apps/frontend/src/lib/specNormalization.ts` | Spec-builder UX helpers and input normalization | Mixed value. The helpers are small, but they duplicate policy that also exists in backend parsing and spec handling. | Some of this should stay UI-specific; some should become shared contract/policy helpers. |
| `apps/frontend/src/lib/languages/*` | Client-only language labels and test-count helpers | Cohesive renderer-specific helpers. | This is a healthy layer as long as it stays presentation-oriented. |
| `apps/frontend/src/types/generationProgress.ts` | Renderer copy of engine progress types | Contract duplication. | Every new event requires synchronized manual edits across app boundaries. |

## 3. Architecture Weaknesses

### Runtime map and boundary crossings

The main runtime path is currently:

`apps/ide/main.js` -> `apps/ide/preload.js` -> `apps/backend/src/ipcServer.ts` -> backend services / generation / judge / database -> `apps/frontend/src/app/*`

That path is valid and preserves the repo’s main safety invariant: renderer traffic stays IPC-only and untrusted code stays Docker-sandboxed. The weakness is not the existence of this path. The weakness is that each boundary layer is wider than it should be.

### UI / application / domain / infrastructure separation

**UI layer**

- Intended: renderer pages compose UI and consume engine contracts.
- Current: `apps/frontend/src/app/page.tsx` and `apps/frontend/src/app/activity/[id]/page.tsx` both contain application flow logic, local storage behavior, and event reduction.
- Result: the renderer is partly acting as an application layer.

**Application / orchestration layer**

- Intended: backend services should coordinate thread flow, generation, and judging.
- Current: orchestration is split across `apps/ide/main.js`, `apps/backend/src/ipcServer.ts`, `apps/backend/src/services/sessionService.ts`, `apps/backend/src/generation/index.ts`, and large renderer pages.
- Result: no single thin application layer exists. Instead there are multiple coordinators, each carrying partial business logic.

**Domain / core logic layer**

- Strongest areas: `apps/backend/src/planner/*`, `apps/backend/src/compiler/*`, much of `apps/backend/src/contracts/*`.
- Weakness: domain rules still leak into dialogue parsing, renderer normalization, generation helpers, and prompt-specific code.
- Result: the domain layer exists, but it is not consistently the only place where core rules live.

**Infrastructure / execution layer**

- Strongest areas: `apps/backend/src/judge/*`, `apps/backend/src/languages/*`, `apps/backend/src/infra/llm/adapters/*`, `apps/ide/localLlm/*`.
- Weakness: provider/runtime selection rules and status contracts cross from Electron main into frontend pages and backend route planning.
- Result: infrastructure code is reasonably modular internally, but the contracts around it are not centralized.

### Major flow analysis

**Flow 1: user input -> thread/spec-building -> generation**

- Path: renderer home page -> preload bridge -> Electron main IPC handlers -> backend IPC server -> `sessionService.processSessionMessage()` -> compiler/agent helpers -> `sessionService.generateFromSession()` -> planner -> generation pipeline.
- Weak boundary: the frontend page owns message UX and progress-event reduction, while `sessionService.ts` owns both dialogue and generation orchestration.
- Implicit contract: `questionKey`, `nextQuestion`, confirmation behavior, and progress event semantics are shared across renderer and backend without a single imported contract boundary.

**Flow 2: generation/regeneration -> run tracking -> activity persistence**

- Path: `ipcServer.ts` -> `runGenerationWithRunTracking()` -> `sessionService.generateFromSession()` -> `generation/index.ts` -> `slotStages.ts` or `perSlotGenerator.ts` -> database writes.
- Weak boundary: `ipcServer.ts` knows about run tracking and method-specific side effects instead of delegating to a generation application service.
- Architecture drift: `generation/index.ts` still decides whether a slot goes through staged generation or legacy injected generation logic.

**Flow 3: activity solve/editor -> judge run/submit**

- Path: `apps/frontend/src/app/activity/[id]/page.tsx` -> activity utils -> preload bridge -> Electron main -> `ipcServer.ts` judge methods -> judge/language modules -> Docker.
- Weak boundary: the renderer reconstructs workspace state and parses judge output details instead of consuming a normalized backend view model.
- Tight coupling: `activity/[id]/utils.ts` knows about JUnit output and SQL mismatch formats that are really backend execution details.

**Flow 4: LLM configuration -> route plan -> local runtime lease -> model execution**

- Path: settings page -> preload bridge -> Electron main secrets/runtime handlers -> `localLlm/orchestrator.js` -> route-plan creation in `main.js` -> backend `infra/llm` route planner and provider adapters.
- Weak boundary: configuration and execution contracts are split across Electron main, frontend page-local types, and backend route normalization.
- Tight coupling: capability inference is partly generic (`routePlanner.ts`) but still encodes Ollama model-size assumptions.

### Circular dependencies and bidirectional knowledge

- A direct import cycle exists between `apps/backend/src/agent/commitments.ts` and `apps/backend/src/agent/readiness.ts`.
- I did not find evidence of large cross-package import cycles in the main runtime hotspots, but the more important problem is bidirectional knowledge without import cycles:
  - Electron main knows backend method names, route-plan semantics, secret handling, and local runtime specifics.
  - Renderer pages know backend progress semantics and judge-output formats.
  - Backend generation orchestration knows about both old and new generation models.

### Hidden contracts and magic behavior

- `problem_style` is effectively fixed to stdout by backend policy, but this behavior is enforced across dialogue parsing, spec compilation, and docs rather than a single obvious contract owner.
- Route-plan defaults, capability inference, and fallback-chain escalation are spread across Electron main and backend LLM modules.
- The thread-to-session naming mismatch forces implicit translation across UI, IPC, and persistence.

## 4. Modularity Opportunities

### 4.1 Model execution modularity

**Current state**

- Backend provider adapters are already split under `apps/backend/src/infra/llm/adapters/*`.
- Electron main still builds and owns local provider state, route-plan shaping, and runtime readiness logic.
- Frontend settings pages duplicate route-plan and runtime status contracts.

**What should move**

- Move route-plan contract types and provider status payloads into one shared contract module.
- Move provider-specific capability inference out of `routePlanner.ts` and into provider metadata or adapter capabilities.
- Introduce a `LocalRuntimeProvider` interface in `apps/ide/localLlm` so Electron main depends on a generic local provider lifecycle instead of Ollama specifics.

**Where it should move**

- Shared contracts: a new shared package or a shared `contracts` workspace module consumed by backend, frontend, and Electron main.
- Provider capabilities: `apps/backend/src/infra/llm/adapters/*` or adjacent provider metadata modules.
- Local runtime interface: `apps/ide/localLlm/index.js` plus provider-specific drivers under `apps/ide/localLlm/providers/*`.

**Why this boundary is better**

- Codemm could support multiple Ollama models, different local providers, and future non-Ollama backends without leaking provider rules into pages and Electron main handlers.

**Risk**

- Contract centralization is low-risk.
- A local runtime provider interface is structural but still incremental because the existing Ollama driver can become the first adapter.

### 4.2 Agent/runtime decoupling

**Current state**

- `sessionService.ts` handles dialogue, state transitions, persistence, generation dispatch, fallback, and regeneration.
- `ipcServer.ts` still performs run tracking and method-specific orchestration.

**What should move**

- Split `sessionService.ts` into:
  - `threadConversationService`
  - `threadReadinessService`
  - `threadGenerationService`
  - `threadRepository` accessors
- Move generation run tracking out of `ipcServer.ts` into `threadGenerationService`.
- Keep `dialogueService.ts` and `confirmationFlow.ts` as dedicated policy helpers.

**Where it should move**

- `apps/backend/src/services/threads/*` for application services.
- `apps/backend/src/repositories/*` once `database.ts` is decomposed.

**Why this boundary is better**

- The agent loop becomes independent from transport and easier to test. Regeneration and checkpoint recovery can share the same generation command path instead of being embedded in a large session service.

**Risk**

- Moderate. This is mostly extraction and contract cleanup, not a rewrite, but it touches the core thread flow.

### 4.3 IDE/backend separation

**Current state**

- Electron main is the only legal bridge, but it currently contains backend-aware business decisions.
- Frontend pages speak to bridge methods directly and shape some backend semantics themselves.

**What should move**

- Move IPC handler registration in `apps/ide/main.js` into feature-specific registrar modules such as:
  - `ipc/threads.js`
  - `ipc/activities.js`
  - `ipc/judge.js`
  - `ipc/llm.js`
- Add small bridge client wrappers in the frontend so pages consume `threadsClient`, `activitiesClient`, `judgeClient`, and `llmClient` rather than `window.codemm` directly.

**Where it should move**

- IDE: `apps/ide/ipc/*`
- Frontend: `apps/frontend/src/lib/bridge/*`

**Why this boundary is better**

- Electron main stays a security and boot boundary. The backend owns behavior. The frontend consumes stable clients instead of raw bridge methods.

**Risk**

- Low to moderate. Channel names and invariants can stay unchanged while files are split.

### 4.4 Config and contract design

**Current state**

- Route-plan shapes, generation progress events, and thread payloads are duplicated.
- Config behavior such as provider activation, fallback chains, and default model inference is partly implicit.

**What should move**

- Centralize:
  - `GenerationProgressEvent`
  - route-plan types
  - runtime status types
  - thread response DTOs
- Add a small config module that turns provider settings into an explicit runtime contract instead of page-local assumptions.

**Where it should move**

- Shared contracts package.
- `apps/backend/src/infra/llm/config.ts` or equivalent for route-plan resolution.
- `apps/ide/main/llmPreferences.js` or equivalent for persistence of local settings in Electron.

**Why this boundary is better**

- “Magic behavior” becomes explicit and testable, and UI pages no longer need to mirror backend semantics manually.

**Risk**

- Low for types and DTO extraction.
- Moderate for centralizing config if existing tests assume current ad hoc shaping.

### Additional modularization wins

- Split `apps/backend/src/database.ts` into `migrations.ts`, `db.ts`, and per-aggregate repositories without changing table schemas first.
- Move judge-output parsing out of `apps/frontend/src/app/activity/[id]/utils.ts` into backend-normalized result payloads or shared parsers.
- Pull shared generation helper logic out of `perSlotGenerator.ts` and `slotStages.ts` into explicit stage helpers so the staged pipeline becomes the only real orchestration path.

## 5. Documentation Gaps

### Documents that are accurate

- `README.md`
- `CONTRIBUTING.md`
- `docs/ARCHITECTURE.md`
- `docs/FUNCTIONS.md`
- `docs/TROUBLESHOOTING.md`
- `docs/architecture/IDE_FIRST.md`
- `docs/architecture/LOCAL_LLM_ORCHESTRATION.md`
- `docs/architecture/MIGRATION.md`
- `apps/backend/docs/api/backend.md`
- `apps/frontend/docs/architecture.md`
- `apps/frontend/docs/data-flow.md`

These documents describe the current Electron + IPC + local-only model accurately enough to guide contributors.

### Documents that are partially outdated

- `apps/frontend/docs/index.md`
- `apps/backend/docs/index.md`
- `apps/frontend/docs/overview.md`
- `apps/backend/docs/overview.md`

These index-level docs still sit above mixed-quality doc sets. Some linked pages are current, but the collections as a whole are not trustworthy without triage.

### Documents that are misleading or stale

- `apps/backend/docs/architecture.md`
  - Still describes an Express HTTP API, `src/server.ts`, `/sessions/*`, `/auth/*`, `/profile`, and `/community` routes.
- `apps/backend/docs/data-flow.md`
  - Still describes `POST /sessions/:id/messages`, auth-gated generation, SSE progress, and learner-profile persistence.
- `apps/frontend/docs/pipelines/generation.md`
  - Still instructs the renderer to use `EventSource` and `POST /sessions/:id/generate`.
- `apps/frontend/docs/agentic-design/tools-and-actions.md`
  - Still describes sessions APIs, SSE, auth, and profile endpoints.
- Most of the remaining app-local doc trees under `apps/backend/docs/agentic-design/*`, `apps/backend/docs/pipelines/*`, `apps/backend/docs/state-and-models.md`, `apps/frontend/docs/agentic-design/*`, `apps/frontend/docs/pipelines/*`, and `apps/frontend/docs/state-and-models.md`
  - Many of these still reference the old HTTP/auth/session architecture and should not be treated as current without line-by-line validation.
- `apps/backend/documentation/*` and `apps/frontend/documentation/*`
  - These are legacy documentation remnants. `apps/backend/documentation/architecture.md` is explicitly deprecated, and `apps/frontend/documentation/USER_PROFILES_README.md` points to the old backend repo.

### Critical things that are currently undocumented

- The actual generation split between `apps/backend/src/generation/index.ts`, `apps/backend/src/pipeline/slotStages.ts`, and `apps/backend/src/generation/perSlotGenerator.ts`.
- The ownership model for route plans, provider activation, and runtime readiness across Electron main, backend LLM infra, and the renderer.
- Which contracts are canonical and which ones are frontend mirrors.
- The safe extension path for:
  - adding a new model provider
  - adding a new local runtime backend
  - adding a new language/judge adapter
- The current thread/session naming translation and why persistence still uses `session` concepts.
- Contributor guidance for refactoring the major coordinator files without breaking Docker or IPC safety invariants.

## 6. Step-by-Step Refactor Plan

### Phase 1 — High-impact, low-risk fixes

| Files or modules | Current problem | Proposed change | Why it matters | Expected impact | Risk | When |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/backend/src/contracts/generationProgress.ts`, `apps/frontend/src/types/generationProgress.ts`, `apps/frontend/src/app/page.tsx`, `apps/frontend/src/app/settings/llm/page.tsx` | Contract duplication across backend and renderer | Create one shared contract source for generation events and LLM route-plan/status payloads; update pages to import it | Removes drift and reduces regression risk when event shapes evolve | High leverage, immediate simplification | Low | Now |
| `apps/backend/src/agent/commitments.ts`, `apps/backend/src/agent/readiness.ts` | Direct import cycle and scattered readiness policy | Move `REQUIRED_CONFIDENCE` into a third policy module used by both files | Removes the only detected import cycle and clarifies policy ownership | Small but concrete cleanup | Low | Now |
| `apps/ide/main.js` | IPC registration is mixed with boot and runtime logic | Extract handler registration into feature registrars while keeping channel names unchanged | Shrinks the Electron main blast radius without changing architecture | Better maintainability and testability | Low to moderate | Now |
| `apps/backend/src/ipcServer.ts` | Transport and application orchestration are mixed | Split handler map into `threads`, `activities`, and `judge` modules; keep `handle()` as thin dispatch | Makes the engine boundary easier to audit and evolve | Medium maintainability gain | Low to moderate | Now |
| `apps/backend/src/database.ts` | Migrations and repositories live together | Extract repositories into separate files while leaving schema and migrations untouched initially | Makes aggregate ownership visible and lowers change contention | Medium | Low to moderate | Now |
| `apps/frontend/src/app/page.tsx`, `apps/frontend/src/app/activity/[id]/page.tsx`, `apps/frontend/src/app/settings/llm/page.tsx` | Route components own orchestration logic | Extract bridge clients, event reducers, and route-specific hooks from page files | Restores route components to view composition roles | High frontend maintainability gain | Moderate | Now |
| Root docs plus stale app docs | Contradictory architecture documentation | Mark stale app docs as deprecated or replace with short stubs pointing to canonical root docs; remove obviously wrong HTTP/auth guidance | Prevents contributors from following the wrong architecture | Immediate contributor safety win | Low | Now |

### Phase 2 — Structural modularization

| Files or modules | Current problem | Proposed change | Why it matters | Expected impact | Risk | When |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/backend/src/services/sessionService.ts` and adjacent helpers | Core thread flow lives in one god service | Split into thread conversation, readiness, and generation application services backed by explicit repositories | Creates a real application layer in the backend | High | Moderate | Next |
| `apps/backend/src/generation/index.ts`, `apps/backend/src/generation/perSlotGenerator.ts`, `apps/backend/src/pipeline/*` | New and legacy generation paths coexist | Make `slotStages.ts` the only production orchestration path; keep legacy generator behind a narrow compatibility adapter or test seam | Eliminates architecture drift and duplicate stage logic | High | Moderate to high | Next |
| `apps/backend/src/services/activityProblemEditService.ts`, generation helpers | Problem editing duplicates generation knowledge | Introduce a dedicated problem-edit workflow that reuses stage validators and language contracts instead of rebuilding prompt rules ad hoc | Prevents a second generation architecture from forming | Medium | Moderate | Next |
| `apps/frontend/src/app/activity/[id]/utils.ts`, backend judge contracts | Renderer parses backend execution artifacts | Normalize judge outputs in backend or shared parsers so the renderer consumes stable display models | Reduces backend-format leakage into UI | Medium | Moderate | Next |
| `apps/ide/main.js`, `apps/ide/localLlm/*`, `apps/backend/src/infra/llm/*` | Provider/runtime contracts are split | Introduce explicit local-runtime and route-plan service boundaries with shared DTOs | Clarifies ownership of LLM configuration and readiness | High | Moderate | Next |

### Phase 3 — Deeper architecture improvements

| Files or modules | Current problem | Proposed change | Why it matters | Expected impact | Risk | When |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/ide/localLlm/*`, `apps/backend/src/infra/llm/*` | Backend/provider modularity is only partial | Introduce plugin-like execution backends: local runtime adapters in Electron, provider adapters in backend, and one shared route-plan contract | Makes future non-Ollama and mixed-provider support an architectural feature instead of a patchwork | High long-term payoff | Structural | Later |
| Backend repositories and application services | Persistence and domain concepts still leak into orchestration files | Align thread naming and repository ownership at the application boundary while keeping data migrations incremental | Removes conceptual friction and reduces translation code | Medium to high | Structural | Later |
| Generation diagnostics and run event ownership | Progress diagnostics are useful but spread across transport and generation layers | Define a dedicated generation run domain with explicit events, state snapshots, and replay rules | Improves restart safety, observability, and testability | Medium | Structural | Later |
| Contributor architecture docs | Refactor safety depends on tribal knowledge | Add a current module map, runtime flow diagram, contract-ownership doc, and “how to add a provider/language safely” guide | Keeps future modularity work from drifting again | High contributor payoff | Low | Later |

### Recommended execution order

1. Fix the contract duplication and stale docs first.
2. Split `main.js`, `ipcServer.ts`, and frontend route pages into thinner files without changing public behavior.
3. Split `database.ts` and `sessionService.ts` so repository and application-service ownership become explicit.
4. Collapse generation onto one production orchestration path.
5. Introduce provider/runtime interfaces after the route-plan contract is centralized.

### Refactor strategy constraints

- Preserve IPC-only engine access.
- Preserve Docker-only execution of untrusted code.
- Do not rewrite persistence schemas unnecessarily.
- Prefer extraction and contract centralization over new abstractions that are not already justified by current coupling.
