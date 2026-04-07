require("../../helpers/setupBase");
require("../../helpers/loadRealProviderAuth").loadRealProviderAuth();

// This integration test intentionally hits real provider APIs (token-costing).
// It skips automatically when a provider key is not present.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCodemmCompletion } = require("../../../src/infra/llm");

const RUN_SMOKE = String(process.env.CODEMM_RUN_REAL_PROVIDER_SMOKE || "").trim() === "1";

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

function extractText(out) {
  const blocks = Array.isArray(out?.content) ? out.content : [];
  return blocks.map((b) => (b && b.type === "text" ? String(b.text || "") : "")).join("\n");
}

test(
  "llm (real): Anthropic completion works (skips if ANTHROPIC_API_KEY missing)",
  { timeout: 60_000 },
  async (t) => {
    if (!RUN_SMOKE) {
      t.skip("Set CODEMM_RUN_REAL_PROVIDER_SMOKE=1 to run real provider smoke tests.");
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      t.skip("ANTHROPIC_API_KEY not set");
      return;
    }

    // Let users override which model they have access to via ANTHROPIC_MODEL.
    withEnv(t, {
      CODEX_PROVIDER: "anthropic",
      // Avoid accidentally using OpenAI/Gemini in auto mode.
      CODEX_API_KEY: null,
      OPENAI_API_KEY: null,
      GEMINI_API_KEY: null,
      GOOGLE_API_KEY: null,
    });

    const out = await createCodemmCompletion({
      system: 'Reply with exactly "OK". No other text.',
      user: "ping",
      temperature: 0,
      maxTokens: 20,
    });

    const text = extractText(out).trim();
    assert.ok(text.length > 0);
    assert.ok(/^ok\b/i.test(text), `Unexpected response: ${JSON.stringify(text)}`);
  }
);

test(
  "llm (real): Gemini completion works (skips if GEMINI_API_KEY/GOOGLE_API_KEY missing)",
  { timeout: 60_000 },
  async (t) => {
    if (!RUN_SMOKE) {
      t.skip("Set CODEMM_RUN_REAL_PROVIDER_SMOKE=1 to run real provider smoke tests.");
      return;
    }

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      t.skip("GEMINI_API_KEY/GOOGLE_API_KEY not set");
      return;
    }

    withEnv(t, {
      CODEX_PROVIDER: "gemini",
      // Avoid accidentally using OpenAI/Anthropic in auto mode.
      CODEX_API_KEY: null,
      OPENAI_API_KEY: null,
      ANTHROPIC_API_KEY: null,
    });

    const out = await createCodemmCompletion({
      system: 'Reply with exactly "OK". No other text.',
      user: "ping",
      temperature: 0,
      maxTokens: 20,
    });

    const text = extractText(out).trim();
    assert.ok(text.length > 0);
    assert.ok(/^ok\b/i.test(text), `Unexpected response: ${JSON.stringify(text)}`);
  }
);
