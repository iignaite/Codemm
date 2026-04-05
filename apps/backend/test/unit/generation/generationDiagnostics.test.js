require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { collectAttemptDiagnostics } = require("../../../src/generation/diagnostics");

test("collectAttemptDiagnostics parses summaries and repair metadata from run events", () => {
  const rows = [
    {
      seq: 0,
      type: "progress",
      payload_json: JSON.stringify({
        type: "route_selected",
        slotIndex: 0,
        routeRole: "tests",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        capability: "balanced",
      }),
      created_at: "2026-03-02T00:59:59.000Z",
    },
    {
      seq: 1,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_attempt_summary",
        slotIndex: 0,
        attempt: 1,
        maxAttempts: 3,
        phase: "generate",
        status: "failed",
        kind: "contract",
        message: "Schema validation failed",
        remediation: ["Regenerate this slot"],
      }),
      created_at: "2026-03-02T01:00:00.000Z",
    },
    {
      seq: 2,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_failure_diagnostic",
        slotIndex: 0,
        attempt: 1,
        kind: "contract",
        message: "Schema validation failed",
        remediation: ["Regenerate this slot", "Simplify prompt constraints"],
        final: false,
      }),
      created_at: "2026-03-02T01:00:01.000Z",
    },
    {
      seq: 3,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_stage_started",
        slotIndex: 0,
        stage: "tests",
        attempt: 1,
        routeRole: "tests",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
      }),
      created_at: "2026-03-02T01:00:01.500Z",
    },
    {
      seq: 4,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_stage_finished",
        slotIndex: 0,
        stage: "tests",
        attempt: 1,
        status: "failed",
        routeRole: "tests",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        durationMs: 1200,
        failureKind: "contract",
        message: "Tests were malformed",
      }),
      created_at: "2026-03-02T01:00:01.700Z",
    },
    {
      seq: 5,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_escalated",
        slotIndex: 0,
        stage: "tests",
        routeRole: "tests",
        fromModel: "qwen2.5-coder:1.5b",
        toModel: "qwen2.5-coder:7b",
        reason: "schema_invalid_twice",
      }),
      created_at: "2026-03-02T01:00:01.900Z",
    },
    {
      seq: 6,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_repair_applied",
        slotIndex: 0,
        attempt: 1,
        strategy: "retry_full_slot",
        detail: "Retrying generation with contract diagnostics.",
      }),
      created_at: "2026-03-02T01:00:02.000Z",
    },
    {
      seq: 7,
      type: "progress",
      payload_json: JSON.stringify({
        type: "slot_attempt_summary",
        slotIndex: 0,
        attempt: 2,
        maxAttempts: 3,
        phase: "complete",
        status: "success",
      }),
      created_at: "2026-03-02T01:00:03.000Z",
    },
  ];

  const out = collectAttemptDiagnostics(rows);
  assert.equal(out.progressEvents.length, 8);
  assert.equal(out.diagnostics.length, 2);
  assert.equal(out.routeSelections.length, 1);
  assert.equal(out.routeSelections[0].model, "qwen2.5-coder:7b");
  assert.equal(out.stageTimeline.length, 3);
  assert.equal(out.timingSummary.llmMs, 1200);
  assert.equal(out.timingSummary.dockerMs, 0);

  const first = out.diagnostics[0];
  assert.equal(first.slotIndex, 0);
  assert.equal(first.attempt, 1);
  assert.equal(first.status, "failed");
  assert.equal(first.kind, "contract");
  assert.equal(first.repairStrategy, "retry_full_slot");
  assert.deepEqual(first.remediation, ["Regenerate this slot", "Simplify prompt constraints"]);

  const second = out.diagnostics[1];
  assert.equal(second.attempt, 2);
  assert.equal(second.status, "success");

  assert.deepEqual(out.latestFailure, {
    slotIndex: 0,
    attempt: 1,
    kind: "contract",
    message: "Tests were malformed",
    remediation: [],
    final: false,
    stage: "tests",
  });
});
