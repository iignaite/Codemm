import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";

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

export async function runPythonJudge(userCode: string, testSuite: string): Promise<JudgeResult> {
  return runPythonJudgeFiles({ "solution.py": userCode }, testSuite);
}

export async function runPythonJudgeFiles(userFiles: PythonFiles, testSuite: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-py-judge-");

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
      "--tmpfs",
      "/tmp:rw,size=256m",
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
      "codem-python-judge",
    ];

    const { stdout, stderr, exitCode, timedOut } = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", { exitCode, timedOut, stdoutLen: stdout.length, stderrLen: stderr.length });

    const executionTimeMs = Date.now() - start;
    if (exitCode === 0) {
      const inferred = inferPytestTestNames(testSuite);
      return {
        success: true,
        passedTests: inferred,
        failedTests: [],
        stdout,
        stderr,
        executionTimeMs,
        exitCode,
        timedOut,
      };
    }

    const { failed, errored } = parsePytestFailures(stdout + "\n" + stderr);
    const inferred = inferPytestTestNames(testSuite);
    const failing = Array.from(new Set([...failed, ...errored]));
    const passedTests = inferred.filter((t) => !failing.includes(t));
    return {
      success: false,
      passedTests,
      failedTests: failing,
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
