require("../../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { MODEL_PROFILES, resolveCandidateProfiles } = require("../../../../../ide/localLlm/modelCatalog");

test("model catalog: high-RAM machine ranks the largest compatible model first", () => {
  const caps = { totalRamGb: 32, freeRamGb: 20, diskFreeGb: 100, gpu: { available: true } };
  const candidates = resolveCandidateProfiles(caps, { useCase: "generation" });
  assert.equal(candidates[0].model, "qwen2.5-coder:14b");
});

test("model catalog: low free RAM demotes bigger models without hard-blocking", () => {
  const roomy = resolveCandidateProfiles(
    { totalRamGb: 16, freeRamGb: 12, diskFreeGb: 100, gpu: null },
    { useCase: "general" }
  );
  const starved = resolveCandidateProfiles(
    { totalRamGb: 16, freeRamGb: 1, diskFreeGb: 100, gpu: null },
    { useCase: "general" }
  );

  assert.equal(roomy[0].model, "qwen2.5-coder:7b", "with free memory the 7b model wins on a 16GB machine");
  assert.equal(starved[0].model, "qwen2.5-coder:1.5b", "when memory is starved the small model wins");
  assert.ok(
    starved.some((p) => p.model === "qwen2.5-coder:7b"),
    "bigger model stays available as a later candidate"
  );
});

test("model catalog: sub-minimum machines fall back to the least demanding model", () => {
  const caps = { totalRamGb: 4, freeRamGb: 1, diskFreeGb: 100, gpu: null };
  const candidates = resolveCandidateProfiles(caps, { useCase: "general" });
  assert.equal(candidates.length, MODEL_PROFILES.length);
  assert.equal(candidates[0].model, "qwen2.5-coder:1.5b");
  const demands = candidates.map((p) => p.minRamGb);
  assert.deepEqual(demands, [...demands].sort((a, b) => a - b), "ordered by ascending demand");
});

test("model catalog: forced model bypasses scoring", () => {
  const candidates = resolveCandidateProfiles(
    { totalRamGb: 4, freeRamGb: 1 },
    { forcedModel: "custom-model:3b" }
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].model, "custom-model:3b");
});
