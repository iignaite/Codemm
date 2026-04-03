require("../../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../../../../src/infra/llm/codemmProvider");
const { withResolvedLlmSnapshot } = require("../../../../src/infra/llm/executionContext");

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

function stubFetch(t, handler) {
  const prev = global.fetch;
  global.fetch = handler;
  t.after(() => {
    global.fetch = prev;
  });
}

function asUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  return String(input ?? "");
}

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return direct == null ? "" : String(direct);
}

async function asBody(input, init) {
  const raw = init && typeof init.body === "string" ? init.body : "";
  if (raw) return JSON.parse(raw);
  if (input && typeof input.text === "function") {
    const t = await input.clone().text();
    return t ? JSON.parse(t) : null;
  }
  return null;
}

test("llm provider: auto-selects Anthropic when only ANTHROPIC_API_KEY is set", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: null,
    CODEX_API_KEY: null,
    OPENAI_API_KEY: null,
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    ANTHROPIC_API_KEY: "anthropic_test_key",
    ANTHROPIC_VERSION: "2023-06-01",
  });

  /** @type {{url: string, init: any}[]} */
  const calls = [];

  stubFetch(t, async (input, init) => {
    const url = asUrl(input);
    calls.push({ url, init });
    assert.ok(url.endsWith("/v1/messages"));
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-api-key"], "anthropic_test_key");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");

    const body = await asBody(input, init);
    assert.equal(body.model, "claude-test");
    assert.equal(body.max_tokens, 123);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.system, "SYS");
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "USER" }] }]);

    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok-from-anthropic" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const out = await provider.createCodemmCompletion({
    system: "SYS",
    user: "USER",
    model: "claude-test",
    temperature: 0.1,
    maxTokens: 123,
  });

  assert.equal(calls.length, 1);
  assert.equal(out?.content?.[0]?.text, "ok-from-anthropic");
  assert.equal(out?.meta?.provider, "anthropic");
});

test("llm provider: uses Gemini adapter when CODEX_PROVIDER=gemini", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: "gemini",
    CODEX_API_KEY: null,
    OPENAI_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: "google_test_key",
    GEMINI_MODEL: null,
  });

  /** @type {{url: string, init: any}[]} */
  const calls = [];

  stubFetch(t, async (input, init) => {
    const url = asUrl(input);
    calls.push({ url, init });

    assert.ok(url.includes("/models/gemini-test:generateContent"));
    assert.ok(url.includes("key=google_test_key"));
    assert.equal(init.method, "POST");

    const body = await asBody(input, init);
    assert.equal(body.generationConfig.maxOutputTokens, 55);
    assert.equal(body.generationConfig.temperature, 0.25);
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
    assert.ok(prompt.includes("SYS"));
    assert.ok(prompt.includes("USER"));

    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok-from-gemini" }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const out = await provider.createCodemmCompletion({
    system: "SYS",
    user: "USER",
    model: "gemini-test",
    temperature: 0.25,
    maxTokens: 55,
  });

  assert.equal(calls.length, 1);
  assert.equal(out?.content?.[0]?.text, "ok-from-gemini");
  assert.equal(out?.meta?.provider, "gemini");
});

test("llm provider: Gemini falls back to flash when preferred model 404s", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: "gemini",
    CODEX_API_KEY: null,
    OPENAI_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    GEMINI_API_KEY: "gemini_test_key",
    GOOGLE_API_KEY: null,
    GEMINI_MODEL: null,
    CODEX_MODEL: null,
  });

  let call = 0;
  stubFetch(t, async (input) => {
    const url = asUrl(input);
    call++;

    if (call === 1) {
      assert.ok(url.includes("/models/gemini-1.5-pro:generateContent"));
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message:
              "models/gemini-1.5-pro is not found for API version v1beta, or is not supported for generateContent.",
            status: "NOT_FOUND",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }

    assert.ok(url.includes("/models/gemini-1.5-flash:generateContent"));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok-from-fallback" }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const out = await provider.createCodemmCompletion({
    system: "SYS",
    user: "USER",
    model: "gemini-1.5-pro",
  });

  assert.equal(call, 2);
  assert.equal(out?.content?.[0]?.text, "ok-from-fallback");
  assert.equal(out?.meta?.provider, "gemini");
});

test("llm provider: Gemini uses ListModels to find a supported model when flash also 404s", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: "gemini",
    CODEX_API_KEY: null,
    OPENAI_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    GEMINI_API_KEY: "gemini_test_key",
    GOOGLE_API_KEY: null,
    GEMINI_MODEL: null,
    CODEX_MODEL: null,
  });

  let call = 0;
  stubFetch(t, async (input) => {
    const url = asUrl(input);
    call++;

    if (call === 1) {
      assert.ok(url.includes("/models/gemini-1.5-pro:generateContent"));
      return new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 });
    }
    if (call === 2) {
      assert.ok(url.includes("/models/gemini-1.5-flash:generateContent"));
      return new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 });
    }
    if (call === 3) {
      assert.ok(url.includes("/models?"));
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-1.5-pro", supportedGenerationMethods: [] },
            { name: "models/gemini-1.5-flash-8b", supportedGenerationMethods: ["generateContent"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    assert.ok(url.includes("/models/gemini-1.5-flash-8b:generateContent"));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok-from-listmodels" }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const out = await provider.createCodemmCompletion({
    system: "SYS",
    user: "USER",
    model: "gemini-1.5-pro",
  });

  assert.equal(call, 4);
  assert.equal(out?.content?.[0]?.text, "ok-from-listmodels");
  assert.equal(out?.meta?.provider, "gemini");
});

test("llm provider: uses OpenAI adapter when CODEX_PROVIDER=openai", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: "openai",
    CODEX_API_KEY: "openai_test_key",
    OPENAI_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    CODEX_BASE_URL: "https://example.test/v1",
  });

  /** @type {{url: string, init: any}[]} */
  const calls = [];

  stubFetch(t, async (input, init) => {
    const url = asUrl(input);
    calls.push({ url, init });

    assert.ok(url.includes("/chat/completions"));
    assert.equal((init && init.method) || input.method, "POST");
    assert.ok(getHeader((init && init.headers) || input.headers, "authorization").includes("Bearer"));

    const body = await asBody(input, init);
    assert.equal(body.model, "gpt-test");
    assert.equal(body.max_tokens, 77);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);

    return new Response(JSON.stringify({ choices: [{ message: { content: "ok-from-openai" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const out = await provider.createCodemmCompletion({
    system: "SYS",
    user: "USER",
    model: "gpt-test",
    temperature: 0.2,
    maxTokens: 77,
  });

  assert.equal(calls.length, 1);
  assert.equal(out?.content?.[0]?.text, "ok-from-openai");
  assert.equal(out?.meta?.provider, "openai");
});

test("llm provider: explicit provider with missing key throws a clear error", async (t) => {
  withEnv(t, {
    CODEX_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: null,
    CODEX_API_KEY: null,
    OPENAI_API_KEY: null,
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
  });

  await assert.rejects(
    () => provider.createCodemmCompletion({ system: "SYS", user: "USER" }),
    /Missing Anthropic API key/i
  );
});

test("llm provider: resolved snapshot pins the OpenAI request model and base URL", async (t) => {
  /** @type {{url: string, init: any}[]} */
  const calls = [];

  stubFetch(t, async (input, init) => {
    const url = asUrl(input);
    calls.push({ url, init });
    assert.ok(url.startsWith("https://snapshot.example/v1/chat/completions"));
    assert.ok(getHeader((init && init.headers) || input.headers, "authorization").includes("snapshot_test_key"));

    const body = await asBody(input, init);
    assert.equal(body.model, "gpt-snapshot");

    return new Response(JSON.stringify({ choices: [{ message: { content: "ok-from-snapshot" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const out = await withResolvedLlmSnapshot(
    {
      provider: "openai",
      apiKey: "snapshot_test_key",
      model: "gpt-snapshot",
      baseURL: "https://snapshot.example/v1",
      revision: "snapshot-rev-1",
    },
    () =>
      provider.createCodemmCompletion({
        system: "SYS",
        user: "USER",
      })
  );

  assert.equal(calls.length, 1);
  assert.equal(out?.content?.[0]?.text, "ok-from-snapshot");
});

test("llm provider: non-ready Ollama snapshot is rejected before inference", async () => {
  await assert.rejects(
    () =>
      withResolvedLlmSnapshot(
        {
          provider: "ollama",
          model: "qwen2.5-coder:7b",
          baseURL: "http://127.0.0.1:11434",
          readiness: "DEGRADED",
          revision: "snapshot-rev-2",
        },
        () => provider.createCodemmCompletion({ system: "SYS", user: "USER" })
      ),
    /not READY/i
  );
});
