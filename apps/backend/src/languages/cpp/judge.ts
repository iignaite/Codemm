import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeCompileTimeoutMs, getJudgeExecutionTimeoutMs, getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";
import { buildJudgeResult, COMPILE_TIMEOUT_MARKER, EXEC_TIMEOUT_MARKER } from "../../judge/outcome";

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

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

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
      `timeout -k 1s ${secondsFromMs(getJudgeCompileTimeoutMs())}s sh -lc 'g++ -std=c++20 -O2 -pipe -Wall -Wextra -Wno-unused-parameter -o /tmp/test /workspace/test.cpp' || { status=$?; if [ "$status" -eq 124 ]; then echo '${COMPILE_TIMEOUT_MARKER}' >&2; exit 124; fi; exit "$status"; }`;
    const runCmd =
      `timeout -k 1s ${secondsFromMs(getJudgeExecutionTimeoutMs())}s sh -lc '/tmp/test' || { status=$?; if [ "$status" -eq 124 ]; then echo '${EXEC_TIMEOUT_MARKER}' >&2; exit 124; fi; exit "$status"; }`;

    const args = [
      "run",
      "--rm",
      "--network",
      "none",
	      "--read-only",
	      "--user",
	      "65534:65534",
	      "--cap-drop",
	      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "512m",
      "--cpus",
      "1.0",
      "--tmpfs",
      "/tmp:rw,exec",
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

    const capture = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", {
      exitCode: capture.exitCode,
      timedOut: capture.timedOut,
      outputLimitExceeded: capture.outputLimitExceeded,
      stdoutLen: capture.stdout.length,
      stderrLen: capture.stderr.length,
    });

    const executionTimeMs = Date.now() - start;
    const { passed, failed } = parseCppRunner(capture.stdout);
    return buildJudgeResult({
      success: capture.exitCode === 0 && !capture.timedOut && !capture.outputLimitExceeded,
      passedTests: passed,
      failedTests: failed,
      executionTimeMs,
      capture,
    });
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
