require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { collectAttemptDiagnostics } = require("../../../src/generation/diagnostics");

test("collectAttemptDiagnostics parses summaries and repair metadata from run events", () => {
  const rows = [
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
        type: "slot_repair_applied",
        slotIndex: 0,
        attempt: 1,
        strategy: "retry_full_slot",
        detail: "Retrying generation with contract diagnostics.",
      }),
      created_at: "2026-03-02T01:00:02.000Z",
    },
    {
      seq: 4,
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
  assert.equal(out.progressEvents.length, 4);
  assert.equal(out.diagnostics.length, 2);

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
    message: "Schema validation failed",
    remediation: ["Regenerate this slot", "Simplify prompt constraints"],
    final: false,
  });
});

