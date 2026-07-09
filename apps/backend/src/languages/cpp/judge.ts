import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";

function parseCppRunner(stdout: string): { passed: string[]; failed: string[] } {
  const clean = stripAnsi(stdout);
  const passed = new Set<string>();
  const failed = new Set<string>();
  const re = /^\s*\[(PASS|FAIL)\]\s+(test_case_[A-Za-z0-9_]+)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const status = m[1];
    const name = m[2];
    if (!status || !name) continue;
    if (status === "PASS") passed.add(name);
    if (status === "FAIL") failed.add(name);
  }
  return { passed: Array.from(passed), failed: Array.from(failed) };
}

export type CppFiles = Record<string, string>;

export async function runCppJudge(userCode: string, testSuite: string): Promise<JudgeResult> {
  return runCppJudgeFiles({ "solution.cpp": userCode }, testSuite);
}

export async function runCppJudgeFiles(userFiles: CppFiles, testSuite: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-cpp-judge-");

  try {
    writeUserFiles(tmp, userFiles);

    const testFilename = "test.cpp";
    if (Object.prototype.hasOwnProperty.call(userFiles, testFilename)) {
      const executionTimeMs = Date.now() - start;
      return {
        success: false,
        passedTests: [],
        failedTests: [],
        stdout: "",
        stderr: `User files include "${testFilename}", which conflicts with the test suite filename.`,
        executionTimeMs,
      };
    }

    writeFileSync(join(tmp, testFilename), testSuite, "utf8");

    const compileCmd =
      "g++ -std=c++20 -O2 -pipe -Wall -Wextra -Wno-unused-parameter -o /tmp/test /workspace/test.cpp";
    const runCmd = "/tmp/test";

    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,size=256m",
      "-v",
      `${tmp}:/workspace:ro`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/bash",
      "codem-cpp-judge",
      "-lc",
      `${compileCmd} && ${runCmd}`,
    ];

    const { stdout, stderr, exitCode, timedOut } = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", { exitCode, timedOut, stdoutLen: stdout.length, stderrLen: stderr.length });

    const executionTimeMs = Date.now() - start;
    const { passed, failed } = parseCppRunner(stdout);
    return {
      success: exitCode === 0,
      passedTests: passed,
      failedTests: failed,
      stdout,
      stderr,
      executionTimeMs,
      exitCode,
      timedOut,
    };
  } catch (e: any) {
    const executionTimeMs = Date.now() - start;
    return {
      success: false,
      passedTests: [],
      failedTests: [],
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? String(e?.error ?? e),
      executionTimeMs,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
