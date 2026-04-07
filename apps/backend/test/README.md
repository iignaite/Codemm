# Tests

Codemm backend uses Node's built-in test runner (`node:test`) with CommonJS test files and `ts-node/register` for importing TypeScript sources.

## Structure

- `test/unit/<component>/`: pure/unit tests (no Docker required), grouped to mirror `src/`.
- `test/integration/<component>/`: tests that touch the DB or multiple modules together, also grouped by area (e.g. `database/`, `routes/`).
- `test/helpers/`: shared test setup helpers.

## Commands

- `npm test`: run all tests.
- `npm run test:unit`: run unit tests only.
- `npm run test:integration`: run integration tests only.
- `node scripts/runTests.js unit generation`: run tests for one component folder.

## Key integration suites

| Test file | Uses DB | Uses Docker judges | Uses real LLM | What it validates | How to scope it down |
|---|---:|---:|---:|---|---|
| `test/integration/languages/activityGenerationEdgeCases.test.js` | ✅ | ❌ | ❌ (stubs) | Dialogue/spec edge-cases + generation plumbing without Docker/LLM flakiness | Run normally; it’s fast |
| `test/integration/languages/activityGenerationMatrix.test.js` | ✅ | ❌ | ❌ (stubs) | Fast language-matrix coverage for java/python/cpp/sql generation plumbing | Run normally; it replaces four duplicated per-language files |
| `test/integration/llm/realActivityGenerationE2e.test.js` | ✅ | ✅ | ✅ | Full production flow across all configured providers plus auto-provider fallback | Use `CODEMM_E2E_PROVIDERS`, `CODEMM_E2E_LANGS`, `CODEMM_E2E_STYLES`, `CODEMM_E2E_COUNTS` |
| `test/integration/llm/realProviderIntegrations.test.js` | ❌ | ❌ | ✅ | Tiny smoke tests for the raw provider adapters (token-costing) | Opt-in: `CODEMM_RUN_REAL_PROVIDER_SMOKE=1` |

## Conventions

- Prefer deterministic tests (no network, no real LLM calls, no Docker).
- When you need the DB, require `test/helpers/setupDb` before importing `src/database` (each test should do this itself so it runs per test file/worker).

## Real-LLM e2e (required)

- `test/integration/llm/realActivityGenerationE2e.test.js` runs the full flow (dialogue + generation + Docker validation) and requires:
  - an LLM API key in the environment (one of `CODEX_API_KEY`/`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`)
  - local Docker running + judge images built (`./run-codem-backend.sh`)

Defaults: this test only runs `CODEMM_E2E_LANGS=java` and `CODEMM_E2E_COUNTS=1` unless you override it.

To run a single “cell” in the matrix:
- `CODEMM_RUN_REAL_PROVIDER_SMOKE=1 CODEMM_E2E_PROVIDERS=openai CODEMM_E2E_LANGS=java CODEMM_E2E_STYLES=stdout CODEMM_E2E_COUNTS=1 npm --workspace codem-backend run test:integration -- llm/realActivityGenerationE2e.test.js`

## Debugging generation failures (the errors in your log)

The real-LLM e2e test ultimately calls `generateFromSession()`, which calls `generateProblemsFromPlan()` (per-slot retries).

When a slot fails after retries, you’ll see a `GenerationSlotFailureError` like:
- `kind="contract"`: LLM output didn’t match the schema/format rules (most commonly `test_suite` shape).
- `kind="tests"` / `kind="compile"` / `kind="timeout"`: Docker judge ran the reference solution and it failed.

To see the raw per-slot LLM output + judge stdout/stderr in your terminal:
- `CODEMM_TRACE=1 CODEMM_TRACE_FULL=1 npm run test:integration`

| Failure kind | Where it comes from | What it usually means | What to inspect next |
|---|---|---|---|
| `contract` | `src/generation/perSlotGenerator.ts` schema/style checks | Bad JSON / missing fields / wrong `test_suite` format | The “Last error:” message + the generated draft’s `test_suite` format rules for that language |
| `tests` | `src/generation/referenceSolutionValidator.ts` (Docker) | Reference solution and tests disagree (or tests are too strict/brittle) | Judge output showing the first failing test (e.g. JUnit `expected … but was …`) |
| `compile` | `src/generation/referenceSolutionValidator.ts` (Docker) | Reference solution didn’t compile | Judge stderr/compile output |
| `timeout` | `src/generation/referenceSolutionValidator.ts` (Docker) | Judge timed out (infinite loop / very slow solution/tests) | Judge stdout/stderr + consider tightening generator prompts |
