import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";
import { inferClassName } from "../../utils/javaCodegen";

function parseJUnitTree(stdout: string): { passed: string[]; failed: string[] } {
  const clean = stripAnsi(stdout);
  const passed: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const line of clean.split(/\r?\n/)) {
    // Example:
    // |   +-- testNamesWithNumbers() [OK]
    // |   +-- testNamesWithSpaces() [X] expected: <...>
    const m = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\(\)\s+\[(OK|X)\]\b/);
    if (!m) continue;
    const name = m[1]!;
    const status = m[2]!;
    if (seen.has(`${name}:${status}`)) continue;
    seen.add(`${name}:${status}`);
    if (status === "OK") passed.push(name);
    if (status === "X") failed.push(name);
  }

  return { passed, failed };
}

export type JavaFiles = Record<string, string>;

export async function runJavaJudge(userCode: string, testSuite: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-judge-");

  try {
    const userClassName = inferClassName(userCode, "Solution");
    const testClassName = inferClassName(testSuite, `${userClassName}Test`);

    writeFileSync(join(tmp, `${userClassName}.java`), userCode, "utf8");
    writeFileSync(join(tmp, `${testClassName}.java`), testSuite, "utf8");

    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m",
      "-v",
      `${tmp}:/workspace`,
      "--workdir",
      "/workspace",
      "codem-java-judge",
    ];

    const { stdout, stderr, exitCode, timedOut } = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", { exitCode, timedOut, stdoutLen: stdout.length, stderrLen: stderr.length });

    const executionTimeMs = Date.now() - start;
    const { passed, failed } = parseJUnitTree(stdout);
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

export async function runJavaJudgeFiles(userFiles: JavaFiles, testSuite: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-judge-");

  try {
    writeUserFiles(tmp, userFiles);

    const testClassName = inferClassName(testSuite, "UserTest");
    const testFilename = `${testClassName}.java`;
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
      "-v",
      `${tmp}:/workspace`,
      "--workdir",
      "/workspace",
      "codem-java-judge",
    ];

    const { stdout, stderr, exitCode, timedOut } = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", { exitCode, timedOut, stdoutLen: stdout.length, stderrLen: stderr.length });

    const executionTimeMs = Date.now() - start;
    const { passed, failed } = parseJUnitTree(stdout);
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
