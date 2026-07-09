require("../../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { inferModelCapability } = require("../../../../src/infra/llm/capability");
const ideCapability = require("../../../../../ide/llm/capability");

const CASES = [
  // [model, provider, expected]
  [undefined, "ollama", "weak"],
  [undefined, "openai", "strong"],
  ["gpt-4.1", "openai", "strong"],
  ["claude-sonnet", "anthropic", "strong"],
  ["qwen2.5-coder:1.5b", "ollama", "weak"],
  ["qwen2.5-coder:3b", "ollama", "weak"],
  ["qwen2.5-coder:7b", "ollama", "balanced"],
  ["llama3.1-8b", "ollama", "balanced"],
  ["qwen2.5-coder:14b", "ollama", "strong"],
  ["deepseek-coder:33b", "ollama", "strong"],
  // Tag-segment size must win over a size embedded in the family name.
  ["yi1.5b-coder:34b", "ollama", "strong"],
  ["mystery-model", "ollama", "balanced"],
];

test("capability: engine inference matches the documented tiers", () => {
  for (const [model, provider, expected] of CASES) {
    assert.equal(inferModelCapability(model, provider), expected, `${provider}/${model}`);
  }
});

test("capability: IDE inference is behaviorally identical to the engine", () => {
  for (const [model, provider] of CASES) {
    assert.equal(
      ideCapability.inferModelCapability(model, provider),
      inferModelCapability(model, provider),
      `${provider}/${model}`
    );
  }
});
