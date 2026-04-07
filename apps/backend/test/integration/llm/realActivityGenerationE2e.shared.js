require("../../helpers/setupDb");
require("../../helpers/loadRealProviderAuth").loadRealProviderAuth();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const { activityDb } = require("../../../src/database");
const { createSession, processSessionMessage, generateFromSession, getSession } = require("../../../src/services/sessionService");

/**
 * Real-LLM + Docker matrix runner.
 *
 * Defaults:
 * - `CODEMM_E2E_LANGS=java,python,cpp,sql`
 * - `CODEMM_E2E_STYLES=stdout`
 * - `CODEMM_E2E_COUNTS=2`
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

function withEnv(t, patch) {
  const keys = Object.keys(patch);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];

  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }

  t.after(() => {
    for (const k of keys) {
      const v = prev[k];
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function hasProviderKey(provider) {
  if (provider === "openai") return Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return false;
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

function registerRealActivityGenerationE2e({ provider }) {
  const test = require("node:test");

  test(
    `e2e (real LLM:${provider}): prompt → dialogue → READY → generateFromSession → activity persisted (stdout-only × 4 langs)`,
    // This test exercises real LLM calls + real Docker validation across a matrix.
    // Keep a generous timeout to avoid parent cancellation cascading into many subtest failures.
    { timeout: 6 * 60 * 60 * 1000 },
    async (t) => {
      if (!["openai", "anthropic", "gemini"].includes(provider)) {
        t.skip(`Unknown provider "${provider}"`);
        return;
      }

      if (!hasProviderKey(provider)) {
        t.skip(`Missing API key for provider=${provider}`);
        return;
      }

      // Keep behavior stable (workspace mode adds extra variability).
      withEnv(t, { CODEMM_WORKSPACE_GEN: "0" });
      withEnv(t, { CODEX_PROVIDER: provider });

      const languages = parseCsvEnv("CODEMM_E2E_LANGS", ["java", "python", "cpp", "sql"]);
      const styles = Array.from(
        new Set(parseCsvEnv("CODEMM_E2E_STYLES", ["stdout"]).filter((s) => s === "stdout"))
      );
      if (styles.length === 0) styles.push("stdout");
      const counts = parseCsvEnv("CODEMM_E2E_COUNTS", ["2"]).map((s) => Number(s));

      preflightOrThrow();

      const summaryRows = [];
      try {
        for (const language of languages) {
          for (const style of styles) {
            for (const count of counts) {
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
                  assert.ok(Number.isInteger(count) && count >= 1 && count <= 7, "Counts must be in 1..7");

                  const topic =
                    language === "java"
                      ? "arrays"
                      : language === "python"
                        ? "strings"
                        : language === "cpp"
                          ? "graphs"
                          : "filtering";

                  // Make it 1-turn READY by providing explicit problem_count + difficulty plan.
                  // difficultyPlanParser will deterministically set difficulty_plan and problem_count from "easy:N".
                  const prompt = `Language: ${language}\nStyle: stdout\nTopics: ${topic}\nDifficulty: easy:${count}`;

                  const { sessionId } = createSession("practice");
                  const msg = await processSessionMessage(sessionId, prompt);
                  assert.equal(msg.accepted, true);
                  assert.equal(msg.done, true);
                  assert.equal(msg.state, "READY");
                  assert.equal(msg.spec.language, language);
                  assert.equal(msg.spec.problem_count, count);
                  assert.equal(msg.spec.problem_style, "stdout");

                  const generated = await generateFromSession(sessionId);
                  row.activityId = generated.activityId;
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

                  const s = getSession(sessionId);
                  assert.equal(s.state, "SAVED");
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

module.exports = { registerRealActivityGenerationE2e };
