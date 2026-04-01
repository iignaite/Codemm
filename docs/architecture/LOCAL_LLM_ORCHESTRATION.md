# Local LLM Orchestration

This document describes the production one-button local fallback flow for Ollama in Codemm-Desktop.

## Full Architecture

The local LLM path is split into four layers with one clear owner per concern:

- `apps/frontend`
  - renders status only
  - triggers one user action: `Use Local Model`
  - subscribes to lifecycle updates through preload
- `apps/ide/preload.js`
  - exposes the allowlisted `window.codemm.llm.*` bridge
  - streams lifecycle status events into the renderer
- `apps/ide/main.js`
  - owns the `LocalLlmOrchestrator`
  - owns install, start, pull, readiness, and lease lifecycle
  - resolves the provider snapshot used for each LLM-backed engine call
- `apps/backend`
  - accepts a run-scoped `llmSnapshot` over IPC
  - pins that snapshot in `AsyncLocalStorage`
  - routes all completions through the resolved provider without global mutable runtime config

## Main Components

### LocalLlmOrchestrator

`apps/ide/localLlm/orchestrator.js`

Responsibilities:

- detect Ollama installation
- install Ollama when missing
- start the Ollama server
- select a hardware-appropriate model candidate
- pull the selected model when missing
- probe the selected model before declaring readiness
- persist runtime state to `userData/llm-runtime-state.json`
- issue and release local-runtime leases
- broadcast state updates to any subscribed UI

### LocalRuntimeDriver

`apps/ide/localLlm/ollamaRuntimeDriver.js`

Responsibilities:

- binary discovery
- OS-specific Ollama install flow
- `ollama serve`
- `ollama pull`
- model listing
- probe inference against `/api/chat`

### HostCapabilityProbe

`apps/ide/localLlm/hostCapabilityProbe.js`

Collects:

- platform
- architecture
- total RAM
- free RAM
- CPU count
- GPU availability
- free disk space

### ModelCatalog

`apps/ide/localLlm/modelCatalog.js`

Provides:

- named model profiles instead of a single hardcoded model
- capability-aware ranking
- use-case-aware ranking
- ordered fallback from stronger to smaller candidates

### Snapshot + Lease Model

- Electron main resolves a `ResolvedLlmSnapshot` for every LLM-backed engine call.
- Local leases pin `provider`, `model`, `baseURL`, and `revision`.
- Backend stores the snapshot in `AsyncLocalStorage` for the duration of the request or run.
- All downstream calls inside that request use the same pinned provider/model.

Files:

- `apps/backend/src/infra/llm/types.ts`
- `apps/backend/src/infra/llm/executionContext.ts`
- `apps/backend/src/infra/llm/codemmProvider.ts`

## State Machine

State enum:

- `NOT_INSTALLED`
- `INSTALLING`
- `INSTALLED`
- `STARTING`
- `RUNNING`
- `PULLING_MODEL`
- `PROBING`
- `READY`
- `DEGRADED`
- `FAILED`

Primary transition path:

```text
NOT_INSTALLED
  -> INSTALLING
  -> INSTALLED
  -> STARTING
  -> RUNNING
  -> PULLING_MODEL
  -> PROBING
  -> READY
```

Recovery paths:

- `READY -> DEGRADED`
- `DEGRADED -> STARTING|PULLING_MODEL|PROBING -> READY`
- `FAILED -> INSTALLING|INSTALLED|STARTING|PULLING_MODEL|PROBING`

Concurrency rules:

- only one lifecycle mutation may run at a time
- same `ensureReady` request joins the existing in-flight promise
- conflicting lifecycle requests are rejected with `LOCAL_RUNTIME_BUSY`
- long-running LLM work holds a lease until completion

## Readiness Contract

Ollama is considered `READY` only when all of the following are true:

1. a verified executable binary exists
2. the Ollama server responds to `/api/version`
3. the selected model appears in `/api/tags`
4. a real probe inference succeeds against `/api/chat`

The backend does not treat an Ollama snapshot as valid unless:

- `provider === "ollama"`
- `readiness === "READY"`
- `model` is present

## IPC Contracts

Renderer-facing preload API:

- `window.codemm.llm.getStatus()`
- `window.codemm.llm.ensureReady({ activateOnSuccess?, useCase? })`
- `window.codemm.llm.acquireLease({ reason, forcedModel?, useCase? })`
- `window.codemm.llm.releaseLease({ leaseId })`
- `window.codemm.llm.subscribeStatus({ onEvent })`

Electron → backend IPC payload:

```ts
{
  id: string;
  type: "req";
  method: string;
  params?: Record<string, unknown>;
  context?: {
    llmSnapshot?: ResolvedLlmSnapshot | null;
  };
}
```

## Sequence Flow

### Button Click To First Inference

1. User clicks `Use Local Model`.
2. Renderer calls `window.codemm.llm.ensureReady({ activateOnSuccess: true })`.
3. Electron main enters the orchestrator singleflight path.
4. Host capabilities are probed.
5. A candidate model list is resolved.
6. Ollama is installed if missing.
7. `ollama serve` is started if needed.
8. The selected model is pulled if needed.
9. The model is probed with a real inference.
10. Orchestrator commits `READY`.
11. Electron main saves the active provider preference as `ollama`.
12. The next LLM-backed engine call acquires a lease and sends a pinned `llmSnapshot`.
13. Backend executes the full request using that snapshot only.

## Step-By-Step Runtime Flow

### Chat / Generation / Edit / Hints

1. Electron main receives a UI IPC request.
2. `engineCall(..., { llm: true })` resolves the provider snapshot.
3. Local provider:
   - `acquireLease()` calls `ensureReady()` if needed
   - a lease id is attached to the snapshot
4. Backend IPC request includes `context.llmSnapshot`.
5. Backend stores the snapshot in `AsyncLocalStorage`.
6. `createCodemmCompletion()` resolves the provider from that snapshot.
7. All nested LLM calls during that request use the same snapshot.
8. Electron main releases the lease after completion.

## Failure Handling

Typed local runtime errors include:

- `INSTALL_FAILED`
- `SERVER_START_FAILED`
- `MODEL_PULL_FAILED`
- `PROBE_FAILED`
- `LOCAL_RUNTIME_BUSY`
- `INVALID_STATE_TRANSITION`
- `LOCAL_RUNTIME_FAILED`
- `LOCAL_RUNTIME_DEGRADED`

Failure behavior:

- state is persisted with `lastError`
- UI receives the latest state via `subscribeStatus`
- local inference failures mark the runtime `DEGRADED`
- next `ensureReady()` performs recovery instead of assuming readiness

## Determinism Guarantees

- provider selection is resolved in Electron main, not in scattered call sites
- no `CODEX_MODEL` override is used for app traffic
- no mutable runtime provider state is shared across unrelated runs
- a run-scoped snapshot keeps all LLM calls consistent inside one request/run

## Files To Inspect

- `apps/ide/main.js`
- `apps/ide/preload.js`
- `apps/ide/localLlm/orchestrator.js`
- `apps/ide/localLlm/ollamaRuntimeDriver.js`
- `apps/ide/localLlm/hostCapabilityProbe.js`
- `apps/ide/localLlm/modelCatalog.js`
- `apps/backend/src/ipcServer.ts`
- `apps/backend/src/infra/llm/types.ts`
- `apps/backend/src/infra/llm/executionContext.ts`
- `apps/backend/src/infra/llm/codemmProvider.ts`
