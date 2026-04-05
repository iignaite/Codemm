# Plugins

Codemm Phase 3 introduces two plugin seams:

- backend provider plugins in `apps/backend/src/infra/plugins/provider`
- runtime plugins in:
  - `apps/backend/src/infra/plugins/runtime`
  - `apps/ide/localLlm/plugins`

These seams are compatibility wrappers over the existing implementations. They do not change IPC payloads or execution behavior; they make provider/runtime selection explicit and extensible.

## Provider Plugins

Backend provider plugins implement `ProviderPlugin` in `apps/backend/src/infra/plugins/provider/ProviderPlugin.ts`.

Current pluginized providers:

- `openai`
- `anthropic`
- `ollama`

`gemini` is still supported through the legacy path in `apps/backend/src/infra/llm/codemmProvider.ts`. It is intentionally not pluginized yet to keep the Phase 3 migration behavior-preserving.

Each provider plugin owns:

- provider matching
- configuration/readiness checks
- model resolution from route plan + role route
- completion execution

Core flow:

1. `codemmProvider.ts` resolves the active provider.
2. The provider registry returns the matching plugin.
3. The plugin resolves the model and delegates to the existing adapter.

## Runtime Plugins

Runtime plugins own route-plan normalization and local-runtime wrappers.

Backend runtime plugin responsibilities:

- normalize route plans
- infer capability from model/provider
- resolve per-role routes
- summarize route plans for diagnostics

Electron runtime plugin responsibilities:

- provide the local runtime driver behind a stable plugin surface
- expose the default base URL and runtime identity

Current local runtime plugin:

- `apps/ide/localLlm/plugins/localRuntime.js`
  - wraps the Ollama runtime driver

## Registration

Backend registries:

- `apps/backend/src/infra/plugins/provider/index.ts`
- `apps/backend/src/infra/plugins/runtime/index.ts`

Electron local runtime registry:

- `apps/ide/localLlm/plugins/localRuntime.js`

The registries are intentionally simple arrays today. Phase 3 hardens the boundary first; dynamic discovery can come later if needed.
