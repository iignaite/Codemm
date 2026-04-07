import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeCompileTimeoutMs, getJudgeExecutionTimeoutMs, getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";
import { inferClassName } from "../../utils/javaCodegen";
import { buildJudgeResult, COMPILE_TIMEOUT_MARKER, EXEC_TIMEOUT_MARKER } from "../../judge/outcome";

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

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

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
      "/tmp:rw,exec,size=256m",
      "-v",
      `${tmp}:/workspace:ro`,
      "--entrypoint",
      "/bin/bash",
      "codem-java-judge",
      "-lc",
      [
        "mkdir -p /tmp/classes",
        `timeout -k 1s ${secondsFromMs(getJudgeCompileTimeoutMs())}s sh -lc 'javac -cp \"$JUNIT_JAR:/workspace\" -d /tmp/classes /workspace/*.java' || { status=$?; if [ \"$status\" -eq 124 ]; then echo '${COMPILE_TIMEOUT_MARKER}' >&2; exit 124; fi; exit \"$status\"; }`,
        `timeout -k 1s ${secondsFromMs(getJudgeExecutionTimeoutMs())}s sh -lc 'java -jar \"$JUNIT_JAR\" --class-path /tmp/classes --scan-classpath --details-theme ascii' || { status=$?; if [ \"$status\" -eq 124 ]; then echo '${EXEC_TIMEOUT_MARKER}' >&2; exit 124; fi; exit \"$status\"; }`,
      ].join(" && "),
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
    const { passed, failed } = parseJUnitTree(capture.stdout);
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
      "/tmp:rw,exec,size=256m",
      "-v",
      `${tmp}:/workspace:ro`,
      "--entrypoint",
      "/bin/bash",
      "codem-java-judge",
      "-lc",
      [
        "mkdir -p /tmp/classes",
        `timeout -k 1s ${secondsFromMs(getJudgeCompileTimeoutMs())}s sh -lc 'javac -cp \"$JUNIT_JAR:/workspace\" -d /tmp/classes /workspace/*.java' || { status=$?; if [ \"$status\" -eq 124 ]; then echo '${COMPILE_TIMEOUT_MARKER}' >&2; exit 124; fi; exit \"$status\"; }`,
        `timeout -k 1s ${secondsFromMs(getJudgeExecutionTimeoutMs())}s sh -lc 'java -jar \"$JUNIT_JAR\" --class-path /tmp/classes --scan-classpath --details-theme ascii' || { status=$?; if [ \"$status\" -eq 124 ]; then echo '${EXEC_TIMEOUT_MARKER}' >&2; exit 124; fi; exit \"$status\"; }`,
      ].join(" && "),
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
    const { passed, failed } = parseJUnitTree(capture.stdout);
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
