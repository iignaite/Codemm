require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { CONTAINER_LIMIT_ARGS, withContainerLimits } = require("../../../src/judge/docker");

test("container limits: injected immediately after `run`", () => {
  const args = withContainerLimits(["run", "--rm", "--network", "none", "some-image"]);
  assert.equal(args[0], "run");
  assert.deepEqual(args.slice(1, 1 + CONTAINER_LIMIT_ARGS.length), [...CONTAINER_LIMIT_ARGS]);
  assert.deepEqual(args.slice(1 + CONTAINER_LIMIT_ARGS.length), ["--rm", "--network", "none", "some-image"]);
});

test("container limits: cover pids, memory, cpu, and privilege escalation", () => {
  for (const flag of ["--pids-limit", "--memory", "--memory-swap", "--cpus", "--security-opt"]) {
    assert.ok(CONTAINER_LIMIT_ARGS.includes(flag), `missing ${flag}`);
  }
  assert.ok(CONTAINER_LIMIT_ARGS.includes("no-new-privileges"));
});

test("container limits: non-run commands are left untouched", () => {
  assert.deepEqual(withContainerLimits(["build", "-t", "img", "."]), ["build", "-t", "img", "."]);
});
