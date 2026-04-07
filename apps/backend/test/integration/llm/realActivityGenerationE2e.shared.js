require("../../helpers/setupDb");
require("../../helpers/loadRealProviderAuth").loadRealProviderAuth();

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");

const { activityDb } = require("../../../src/database");
const {
  generationRunRepository,
  generationSlotRunRepository,
  generationSlotTransitionRepository,
} = require("../../../src/database/repositories/generationRunRepository");
const { createSession, processSessionMessage, generateFromSession, getSession } = require("../../../src/services/sessionService");

const RUN_SMOKE = String(process.env.CODEMM_RUN_REAL_PROVIDER_SMOKE || "").trim() === "1";
const PROVIDER_ORDER = ["openai", "anthropic", "gemini"];
const DEFAULT_PROVIDER_LANGS = ["java"];
const DEFAULT_PROVIDER_COUNTS = ["1"];
const DEFAULT_PROVIDER_STYLES = ["stdout"];

/**
 * Real-LLM + Docker matrix runner.
 *
 * Defaults:
 * - `CODEMM_E2E_LANGS=java`
 * - `CODEMM_E2E_STYLES=stdout`
 * - `CODEMM_E2E_COUNTS=1`
 *
 * This test prints a terminal summary table at the end (even on failure).
 */

function parseCsvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProviderFilter() {
  const configured = parseCsvEnv("CODEMM_E2E_PROVIDERS", []);
  if (configured.length === 0) return null;
  const normalized = configured
    .map((provider) => String(provider).trim().toLowerCase())
    .filter((provider) => PROVIDER_ORDER.includes(provider));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : null;
}

function withPatchedEnv(patch, fn) {
  const keys = Object.keys(patch);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];

  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const k of keys) {
      const v = prev[k];
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  };

  return Promise.resolve()
    .then(() => fn())
    .finally(restore);
}

function hasProviderKey(provider) {
  if (provider === "openai") return Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return false;
}

function listAvailableProviders() {
  return PROVIDER_ORDER.filter((provider) => hasProviderKey(provider));
}

function providerKeyPatch(provider, value) {
  if (provider === "openai") {
    return {
      CODEX_API_KEY: value,
      OPENAI_API_KEY: value,
    };
  }
  if (provider === "anthropic") {
    return {
      ANTHROPIC_API_KEY: value,
    };
  }
  if (provider === "gemini") {
    return {
      GEMINI_API_KEY: value,
      GOOGLE_API_KEY: value,
    };
  }
  return {};
}

function buildAutoProviderPatch(expectedProvider) {
  const patch = { CODEX_PROVIDER: "auto" };
  for (const provider of PROVIDER_ORDER) {
    if (provider === expectedProvider) break;
    if (!hasProviderKey(provider)) continue;
    Object.assign(patch, providerKeyPatch(provider, null));
  }
  return patch;
}

function preflightOrThrow() {
  // These tests run the full generation pipeline, including Docker validation.
  const requiredImages = ["codem-java-judge", "codem-python-judge", "codem-cpp-judge", "codem-sql-judge"];
  for (const img of requiredImages) {
    try {
      execSync(`docker image inspect ${img}`, { stdio: "ignore" });
    } catch {
      throw new Error(
        `Missing Docker image "${img}". Build judge images first (recommended: ./run-codem-backend.sh or REBUILD_JUDGE=1 ./run-codem-backend.sh).`
      );
    }
  }
}

function truncateOneLine(value, maxLen) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function printMatrixSummary(rows) {
  const total = rows.length;
  const passed = rows.filter((r) => r.status === "PASS").length;
  const failed = rows.filter((r) => r.status === "FAIL").length;
  const skipped = rows.filter((r) => r.status === "SKIP").length;

  console.log("\n[CODEMM_E2E_MATRIX_SUMMARY]");
  console.log(`total=${total} pass=${passed} fail=${failed} skip=${skipped}`);

  // Keep the table stable + readable in CI terminals.
  console.table(
    rows.map((r) => ({
      provider: r.provider ?? "",
      lang: r.language,
      style: r.style,
      count: r.count,
      status: r.status,
      ms: r.durationMs,
      activityId: r.activityId ?? "",
      failureKind: r.failureKind ?? "",
      slotIndex: r.slotIndex ?? "",
      error: r.error ?? "",
    }))
  );
}

function topicForLanguage(language) {
  if (language === "java") return "arrays";
  if (language === "python") return "strings";
  if (language === "cpp") return "graphs";
  if (language === "sql") return "filtering";
  return "basics";
}

function parseTransitionPayload(payloadJson) {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function collectProvidersForRun(runId) {
  const providers = [];
  const transitions = generationSlotTransitionRepository.listByRun(runId);
  for (const transition of transitions) {
    const payload = parseTransitionPayload(transition.payload_json);
    if (payload && typeof payload.provider === "string" && payload.provider.trim()) {
      providers.push(payload.provider.trim());
    }
  }
  return Array.from(new Set(providers));
}

async function runGenerationCase({
  providerLabel,
  envPatch,
  expectedProvider,
  language,
  style,
  count,
}) {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 7, "Counts must be in 1..7");
  assert.equal(style, "stdout");

  return withPatchedEnv(
    {
      CODEMM_WORKSPACE_GEN: "0",
      ...envPatch,
    },
    async () => {
      const prompt = `Language: ${language}\nStyle: stdout\nTopics: ${topicForLanguage(language)}\nDifficulty: easy:${count}`;
      const { sessionId } = createSession("practice");
      const msg = await processSessionMessage(sessionId, prompt);
      assert.equal(msg.accepted, true);
      assert.equal(msg.done, true);
      assert.equal(msg.state, "READY");
      assert.equal(msg.spec.language, language);
      assert.equal(msg.spec.problem_count, count);
      assert.equal(msg.spec.problem_style, "stdout");

      const generated = await generateFromSession(sessionId);
      assert.ok(generated.activityId);
      assert.equal(generated.problems.length, count);
      for (const p of generated.problems) {
        assert.equal(p.language, language);
        assert.equal("reference_solution" in p, false);
        assert.equal("reference_workspace" in p, false);
      }

      const stored = activityDb.findById(generated.activityId);
      assert.ok(stored);
      const storedProblems = JSON.parse(stored.problems);
      assert.equal(storedProblems.length, count);

      const session = getSession(sessionId);
      assert.ok(session.latestGenerationRunId, `Missing latestGenerationRunId for ${providerLabel}`);
      assert.equal(session.latestGenerationRunStatus, "COMPLETED");

      const run = generationRunRepository.findById(session.latestGenerationRunId);
      assert.ok(run, "Missing persisted generation run.");
      assert.equal(run.status, "COMPLETED");
      assert.equal(run.activity_id, generated.activityId);
      assert.equal(run.total_slots, count);
      assert.equal(run.completed_slots, count);
      assert.equal(run.successful_slots, count);
      assert.equal(run.failed_slots, 0);

      const slotRuns = generationSlotRunRepository.listByRun(run.id);
      assert.equal(slotRuns.length, count);
      for (const slotRun of slotRuns) {
        assert.equal(slotRun.status, "SUCCEEDED");
        assert.equal(slotRun.language, language);
      }

      const providersUsed = collectProvidersForRun(run.id);
      assert.ok(providersUsed.length > 0, "Expected persisted slot transitions to include provider metadata.");
      assert.ok(
        providersUsed.includes(expectedProvider),
        `Expected provider ${expectedProvider} but saw ${providersUsed.join(", ") || "none"}`
      );
      assert.equal(providersUsed.length, 1);

      return {
        activityId: generated.activityId,
        runId: run.id,
        providersUsed,
      };
    }
  );
}

function buildProviderTestMatrix(options = {}) {
  const languages = parseCsvEnv("CODEMM_E2E_LANGS", options.defaultLanguages ?? DEFAULT_PROVIDER_LANGS);
  const styles = Array.from(
    new Set(parseCsvEnv("CODEMM_E2E_STYLES", options.defaultStyles ?? DEFAULT_PROVIDER_STYLES).filter((s) => s === "stdout"))
  );
  if (styles.length === 0) styles.push("stdout");
  const counts = parseCsvEnv("CODEMM_E2E_COUNTS", options.defaultCounts ?? DEFAULT_PROVIDER_COUNTS).map((s) => Number(s));
  return { languages, styles, counts };
}

function registerRealActivityGenerationE2e({ provider, defaultLanguages, defaultCounts, defaultStyles }) {
  const test = require("node:test");
  const matrix = buildProviderTestMatrix({ defaultLanguages, defaultCounts, defaultStyles });

  test(
    `e2e (real activity:${provider}): prompt → READY → generateFromSession → activity persisted`,
    // This test exercises real LLM calls + real Docker validation across a matrix.
    // Keep a generous timeout to avoid parent cancellation cascading into many subtest failures.
    { timeout: 6 * 60 * 60 * 1000 },
    async (t) => {
      if (!RUN_SMOKE) {
        t.skip("Set CODEMM_RUN_REAL_PROVIDER_SMOKE=1 to run real provider E2E tests.");
        return;
      }

      if (!["openai", "anthropic", "gemini"].includes(provider)) {
        t.skip(`Unknown provider "${provider}"`);
        return;
      }

      if (!hasProviderKey(provider)) {
        t.skip(`Missing API key for provider=${provider}`);
        return;
      }

      preflightOrThrow();

      const summaryRows = [];
      try {
        for (const language of matrix.languages) {
          for (const style of matrix.styles) {
            for (const count of matrix.counts) {
              const label = `${provider} ${language} style=${style} count=${count}`;
              const row = {
                provider,
                language,
                style,
                count,
                status: "RUNNING",
                durationMs: 0,
                activityId: undefined,
                failureKind: undefined,
                slotIndex: undefined,
                error: undefined,
              };
              summaryRows.push(row);

              const startedAt = Date.now();
              try {
                await t.test(label, { timeout: 90 * 60 * 1000 }, async () => {
                  const result = await runGenerationCase({
                    providerLabel: provider,
                    envPatch: { CODEX_PROVIDER: provider },
                    expectedProvider: provider,
                    language,
                    style,
                    count,
                  });
                  row.activityId = result.activityId;
                });

                row.status = "PASS";
              } catch (err) {
                row.status = "FAIL";
                row.failureKind = err?.kind;
                row.slotIndex = err?.slotIndex;
                row.error = truncateOneLine(err?.message ?? err, 160);
                throw err;
              } finally {
                row.durationMs = Date.now() - startedAt;
              }
            }
          }
        }
      } finally {
        // Print even if a subtest fails early (token-saving fail-fast behavior).
        printMatrixSummary(summaryRows);
      }
    }
  );
}

function registerRealActivityGenerationAllProvidersE2e(options = {}) {
  const providerFilter = parseProviderFilter();
  const providers = providerFilter ?? PROVIDER_ORDER;
  for (const provider of providers) {
    registerRealActivityGenerationE2e({
      provider,
      defaultLanguages: options.defaultLanguages,
      defaultCounts: options.defaultCounts,
      defaultStyles: options.defaultStyles,
    });
  }
}

function registerRealActivityGenerationAutoFallbackE2e(options = {}) {
  const test = require("node:test");
  const providerFilter = parseProviderFilter();
  const matrix = buildProviderTestMatrix({
    defaultLanguages: options.defaultLanguages ?? ["java"],
    defaultCounts: options.defaultCounts ?? ["1"],
    defaultStyles: options.defaultStyles ?? ["stdout"],
  });

  test(
    "e2e (real activity:auto): generates with the highest-priority available provider and falls back as providers are masked",
    { timeout: 4 * 60 * 60 * 1000 },
    async (t) => {
      if (!RUN_SMOKE) {
        t.skip("Set CODEMM_RUN_REAL_PROVIDER_SMOKE=1 to run real provider E2E tests.");
        return;
      }

      if (providerFilter && providerFilter.length <= 1) {
        t.skip("Auto-provider fallback coverage is skipped when CODEMM_E2E_PROVIDERS narrows execution to one provider.");
        return;
      }

      const availableProviders = listAvailableProviders();
      if (availableProviders.length === 0) {
        t.skip("No real providers configured for auto-mode fallback coverage.");
        return;
      }

      preflightOrThrow();

      const language = matrix.languages[0] ?? "java";
      const style = matrix.styles[0] ?? "stdout";
      const count = matrix.counts[0] ?? 1;
      const summaryRows = [];

      try {
        for (const expectedProvider of availableProviders) {
          const maskedProviders = PROVIDER_ORDER.filter(
            (provider) => provider !== expectedProvider && hasProviderKey(provider) && PROVIDER_ORDER.indexOf(provider) < PROVIDER_ORDER.indexOf(expectedProvider)
          );
          const label =
            maskedProviders.length > 0
              ? `auto falls back to ${expectedProvider} when ${maskedProviders.join(", ")} are unavailable`
              : `auto selects ${expectedProvider} when it is the highest-priority configured provider`;
          const row = {
            provider: `auto->${expectedProvider}`,
            language,
            style,
            count,
            status: "RUNNING",
            durationMs: 0,
            activityId: undefined,
            failureKind: undefined,
            slotIndex: undefined,
            error: undefined,
          };
          summaryRows.push(row);

          const startedAt = Date.now();
          try {
            await t.test(label, { timeout: 90 * 60 * 1000 }, async () => {
              const result = await runGenerationCase({
                providerLabel: `auto:${expectedProvider}`,
                envPatch: buildAutoProviderPatch(expectedProvider),
                expectedProvider,
                language,
                style,
                count,
              });
              row.activityId = result.activityId;
            });
            row.status = "PASS";
          } catch (err) {
            row.status = "FAIL";
            row.failureKind = err?.kind;
            row.slotIndex = err?.slotIndex;
            row.error = truncateOneLine(err?.message ?? err, 160);
            throw err;
          } finally {
            row.durationMs = Date.now() - startedAt;
          }
        }
      } finally {
        printMatrixSummary(summaryRows);
      }
    }
  );
}

module.exports = {
  registerRealActivityGenerationE2e,
  registerRealActivityGenerationAllProvidersE2e,
  registerRealActivityGenerationAutoFallbackE2e,
};
