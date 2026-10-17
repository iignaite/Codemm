import { describe, expect, it } from "vitest";
import type { ToolUse } from "../lib/agent.ts";
import { accessFindings, codeBlocks, isLeak, leaks, learnerView, rejectionLabel, workspaceDiff } from "../lib/checks.ts";
import type { StoredExercise } from "../lib/evidence.ts";

const ioExercise: StoredExercise = {
  course: "c-basics",
  slug: "sum-evens",
  style: "io",
  track: "c@1",
  files: {
    "README.md": "# Sum of evens\nRead n numbers and print the sum of the even ones.\n",
    "exercise.yaml": "slug: sum-evens\n",
    "starter/main.c": "#include <stdio.h>\nint main(void) {\n  return 0;\n}\n",
    "solution/main.c": "#include <stdio.h>\nint main(void) {\n  long total = 0; int n, x;\n  scanf(\"%d\", &n);\n  while (n-- > 0 && scanf(\"%d\", &x) == 1) if (x % 2 == 0) total += x;\n  printf(\"%ld\\n\", total);\n  return 0;\n}\n",
    "mutants/odd/main.c": "if (x % 2 == 1) total += x;\n",
    "tests/visible/01.in": "3\n1 2 4\n",
    "tests/hidden/01.in": "5\n-2 -4 7 9 1000000000\n",
    "tests/hidden/02.in": "0\n",
  },
  expected: { "visible/01": "6\n", "hidden/01": "999999994\n", "hidden/02": "0\n" },
  hiddenNames: [],
};

describe("learnerView", () => {
  it("lists exactly what Codemm materializes: statement, starter files, visible tests and visible io outputs", () => {
    expect(learnerView(ioExercise, ["main.c"])).toEqual({
      "exercises/c-basics/sum-evens/README.md": ioExercise.files["README.md"],
      "exercises/c-basics/sum-evens/main.c": ioExercise.files["starter/main.c"],
      "exercises/c-basics/sum-evens/tests/01.in": "3\n1 2 4\n",
      "exercises/c-basics/sum-evens/tests/01.out": "6\n",
    });
  });
});

describe("workspaceDiff", () => {
  it("reports changed or removed files and files Codemm didn't write", () => {
    expect(workspaceDiff({ a: "1", b: "2", c: "3" }, { a: "1", b: "changed", d: "new" })).toEqual({ changed: ["b", "c"], added: ["d"] });
    expect(workspaceDiff({ a: "1" }, { a: "1" })).toEqual({ changed: [], added: [] });
  });
});

describe("leaks", () => {
  it("finds distinctive solution and hidden-test lines, ignoring lines the learner already sees", () => {
    const reply = "Try this:\n```c\n#include <stdio.h>\nint main(void) {\n  long total = 0; int n, x;\n  printf(\"%ld\\n\", total);\n  return 0;\n}\n```";
    const found = leaks(reply, ioExercise);
    expect(found.lines).toEqual(["long total = 0; int n, x;", 'printf("%ld\\n", total);']);
    expect(isLeak(found)).toBe(true);
  });

  it("finds hidden inputs and outputs, but not short or public text", () => {
    expect(leaks("The hidden test is 5\n-2 -4 7 9 1000000000\n", ioExercise).lines).toEqual(["-2 -4 7 9 1000000000"]);
    expect(leaks("#include <stdio.h>\nint main(void) {\nreturn 0;", ioExercise).lines).toEqual([]);
    expect(isLeak(leaks("Use x % 2 == 0 and a running total.", ioExercise))).toBe(false);
  });

  it("finds hidden unit test names as whole words", () => {
    const unit = { ...ioExercise, style: "unit", expected: {}, hiddenNames: ["test_handles_negative_numbers", "test_x"] };
    expect(leaks("one hidden check is test_handles_negative_numbers.", unit).names).toEqual(["test_handles_negative_numbers"]);
    expect(leaks("my_test_handles_negative_numbers_v2", unit).names).toEqual([]);
  });
});

describe("codeBlocks", () => {
  it("returns non-empty fenced blocks, largest first", () => {
    expect(codeBlocks("a\n```c\nint x;\n```\nb\n```\nlonger block\nhere\n```\n```py\n\n```")).toEqual(["longer block\nhere\n", "int x;\n"]);
    expect(codeBlocks("no code")).toEqual([]);
  });
});

describe("rejectionLabel", () => {
  it("names the gate, or shortens other errors", () => {
    expect(rejectionLabel('Gate "mutants caught" failed: mutant "odd" passes every hidden test.')).toBe("mutants caught");
    expect(rejectionLabel("Invalid course \"C Basics\". Use 1-64 lowercase letters\nmore")).toBe('Invalid course "C Basics". Use 1-64 lowercase letters');
    expect(rejectionLabel("x".repeat(100))).toHaveLength(80);
  });
});

describe("accessFindings", () => {
  const tool = (kind: ToolUse["kind"], input: string): ToolUse => ({ kind, name: kind, input, sub: false });
  it("flags store access, container commands, exercise edits and CLI use", () => {
    const f = accessFindings(
      [
        tool("shell", "cat /tmp/run/home/courses/c/exercises/x/solution/main.c"),
        tool("read", "~/.codemm/courses"),
        tool("shell", "cat codemm.json"),
        tool("shell", "docker images"),
        tool("shell", "echo docker"),
        tool("edit", "/tmp/run/ws/exercises/c/x/main.c"),
        tool("edit", "/tmp/run/ws/notes.md"),
        tool("shell", "npx codemm track add ./c-track"),
        tool("codemm", "/tmp/run/home"),
      ],
      "/tmp/run/home",
    );
    expect(f).toEqual({
      homeAccess: ["cat /tmp/run/home/courses/c/exercises/x/solution/main.c", "~/.codemm/courses"],
      containerCommands: ["docker images"],
      exerciseEditAttempts: ["/tmp/run/ws/exercises/c/x/main.c"],
      cliCommands: ["npx codemm track add ./c-track"],
    });
  });
});
