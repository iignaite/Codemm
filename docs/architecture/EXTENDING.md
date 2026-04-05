# Extending Codemm

Phase 3 makes Codemm extensible through explicit contracts, plugins, and execution workflows.

## Rules

- Keep IPC contracts in `packages/shared-contracts`.
- Keep backend validation/domain rules in `apps/backend/src/contracts`.
- Do not expose secrets to the renderer.
- Do not bypass Docker for untrusted code execution.
- Do not add HTTP engine surfaces without an explicit security review.

## Add a Provider

1. Add or reuse a completion adapter in `apps/backend/src/infra/llm/adapters`.
2. Create a provider plugin in `apps/backend/src/infra/plugins/provider`.
3. Register it in `apps/backend/src/infra/plugins/provider/index.ts`.
4. If the provider adds new route/runtime semantics, keep them behind the plugin boundary rather than spreading them into `codemmProvider.ts`.
5. Update shared contracts only if renderer-visible payloads change.

## Add a Local Runtime

1. Implement the runtime driver behind `apps/ide/localLlm/plugins`.
2. Keep the orchestrator state machine in `apps/ide/localLlm/orchestrator.js`.
3. Expose the runtime through a plugin wrapper instead of importing driver details directly into Electron IPC or boot code.
4. Preserve the current preload -> main -> backend IPC boundary.

## Extend Generation

Preferred order:

1. Add reusable behavior under `apps/backend/src/generation/services`
2. Extend staged generation under `apps/backend/src/pipeline`
3. Keep `legacyAdapter.ts` compatibility-only
4. Do not add new production call sites that depend directly on `perSlotGenerator.ts`

If a generation change affects the public diagnostics or progress stream, update shared DTOs first.

## Add a Judge or Language

1. Add the language profile under `apps/backend/src/languages`
2. Add Docker-backed execution/judge support
3. Normalize renderer-visible results in backend formatters/IPC
4. Keep raw execution artifacts out of renderer parsing code

## Contract-First Workflow

When a backend/frontend boundary changes:

1. update `packages/shared-contracts`
2. update backend IPC returns
3. update frontend bridge clients
4. update hooks/pages

Do not reintroduce page-local DTO copies or backend-internal types into the renderer.
