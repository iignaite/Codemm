# Execution

Codemm now has a reusable execution layer under `apps/backend/src/engine/execution`.

Files:

- `ExecutionContext.ts`
- `Step.ts`
- `ExecutionEngine.ts`

## Purpose

This layer gives long-running workflows a common structure for:

- ordered steps
- shared mutable workflow state
- shared result bags
- lifecycle tracing
- consistent failure boundaries

It is not an agent loop yet. In Phase 3 it is used to structure generation workflows while keeping existing generation logic intact.

## Current Usage

Phase 3 routes two paths through the execution layer:

- `apps/backend/src/generation/orchestrator.ts`
  - one execution step per slot
- `apps/backend/src/services/threads/threadGenerationService.ts`
  - high-level thread generation workflow steps:
    - prepare
    - run generation
    - persist activity

## Step Lifecycle

Each step defines:

- `id`
- `run(ctx)`
- optional `shouldSkip(ctx)`
- optional `onError(ctx, err)`

`ExecutionEngine` emits workflow/step lifecycle events through the observability layer:

- workflow start
- step start
- step success
- step failure
- workflow completion/failure

## Context

`ExecutionContext` carries:

- `workflowId`
- optional `threadId`
- optional `runId`
- optional route plan snapshot
- shared `state`
- shared `results`
- optional progress publisher
- structured logger

This is the foundation for future agentic or multi-step workflows without forcing generation, judging, and thread orchestration to invent their own execution patterns independently.
