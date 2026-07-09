require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { CONTAINER_LIMIT_ARGS, sandboxUserArgs, withContainerLimits } = require("../../../src/judge/docker");

test("container limits: injected immediately after `run`", () => {
  const args = withContainerLimits(["run", "--rm", "--network", "none", "some-image"]);
  assert.equal(args[0], "run");
  const injected = [...CONTAINER_LIMIT_ARGS, ...sandboxUserArgs()];
  assert.deepEqual(args.slice(1, 1 + injected.length), injected);
  assert.deepEqual(args.slice(1 + injected.length), ["--rm", "--network", "none", "some-image"]);
});

test("container limits: cover pids, memory, cpu, and privilege escalation", () => {
  for (const flag of ["--pids-limit", "--memory", "--memory-swap", "--cpus", "--security-opt"]) {
    assert.ok(CONTAINER_LIMIT_ARGS.includes(flag), `missing ${flag}`);
  }
  assert.ok(CONTAINER_LIMIT_ARGS.includes("no-new-privileges"));
});

test("container limits: POSIX sandboxes run as the host user with all capabilities dropped", (t) => {
  if (typeof process.getuid !== "function") {
    t.skip("no getuid on this platform");
    return;
  }
  const args = sandboxUserArgs();
  assert.deepEqual(args, ["--user", `${process.getuid()}:${process.getgid()}`, "--cap-drop", "ALL"]);
  const full = withContainerLimits(["run", "img"]);
  assert.ok(full.includes("--cap-drop"), "cap-drop reaches the argv");
  assert.ok(full.includes("--user"), "user mapping reaches the argv");
});

test("container limits: non-run commands are left untouched", () => {
  assert.deepEqual(withContainerLimits(["build", "-t", "img", "."]), ["build", "-t", "img", "."]);
});
