import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeExecutionTimeoutMs, getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";
import { buildJudgeResult, EXEC_TIMEOUT_MARKER } from "../../judge/outcome";

function parsePytestFailures(output: string): { failed: string[]; errored: string[] } {
  const failed = new Set<string>();
  const errored = new Set<string>();
  const lines = stripAnsi(output).split(/\r?\n/);
  for (const line of lines) {
    let m = line.match(/\bFAILED\s+[^:]+::(test_[A-Za-z0-9_]+)\b/);
    if (m?.[1]) failed.add(m[1]);
    m = line.match(/\bERROR\s+[^:]+::(test_[A-Za-z0-9_]+)\b/);
    if (m?.[1]) errored.add(m[1]);
  }
  return { failed: Array.from(failed), errored: Array.from(errored) };
}

function inferPytestTestNames(testSuite: string): string[] {
  const names: string[] = [];
  const re = /^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(testSuite)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return Array.from(new Set(names));
}

export type PythonFiles = Record<string, string>;

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export async function runPythonJudge(userCode: string, testSuite: string): Promise<JudgeResult> {
  return runPythonJudgeFiles({ "solution.py": userCode }, testSuite);
}

export async function runPythonJudgeFiles(userFiles: PythonFiles, testSuite: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-py-judge-");
  const budgetProfile = {
    overallTimeoutMs: getJudgeTimeoutMs(),
    executeTimeoutMs: getJudgeExecutionTimeoutMs(),
  };

  try {
    writeUserFiles(tmp, userFiles);

    const testFilename = "test_solution.py";
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
      "/tmp:rw",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-e",
      "PYTHONHASHSEED=0",
      "-e",
      "PYTHONUNBUFFERED=1",
      "-e",
      "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
      "-v",
      `${tmp}:/workspace:ro`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/bash",
      "codem-python-judge",
      "-lc",
      `timeout -k 1s ${secondsFromMs(getJudgeExecutionTimeoutMs())}s sh -lc 'pytest -q -p no:cacheprovider' || { status=$?; if [ "$status" -eq 124 ]; then echo '${EXEC_TIMEOUT_MARKER}' >&2; exit 124; fi; exit "$status"; }`,
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
    if (capture.exitCode === 0 && !capture.timedOut && !capture.outputLimitExceeded) {
      const inferred = inferPytestTestNames(testSuite);
      return buildJudgeResult({
        success: true,
        passedTests: inferred,
        failedTests: [],
        executionTimeMs,
        capture,
        budgetProfile,
      });
    }

    const { failed, errored } = parsePytestFailures(capture.stdout + "\n" + capture.stderr);
    const inferred = inferPytestTestNames(testSuite);
    const failing = Array.from(new Set([...failed, ...errored]));
    const passedTests = inferred.filter((t) => !failing.includes(t));
    return buildJudgeResult({
      success: false,
      passedTests,
      failedTests: failing,
      executionTimeMs,
      capture,
      budgetProfile,
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
