import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeExecutionTimeoutMs, getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { mkCodemTmpDir } from "../../judge/tmp";
import { buildJudgeResult, EXEC_TIMEOUT_MARKER } from "../../judge/outcome";

function parseSqlRunner(stdout: string): { passed: string[]; failed: string[] } {
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

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export async function runSqlJudge(userSql: string, testSuiteJson: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-sql-judge-");
  const budgetProfile = {
    overallTimeoutMs: getJudgeTimeoutMs(),
    executeTimeoutMs: getJudgeExecutionTimeoutMs(),
  };

  try {
    writeFileSync(join(tmp, "solution.sql"), userSql, "utf8");
    writeFileSync(join(tmp, "test_suite.json"), testSuiteJson, "utf8");

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
      "-v",
      `${tmp}:/workspace:ro`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/bash",
      "codem-sql-judge",
      "-lc",
      `timeout -k 1s ${secondsFromMs(getJudgeExecutionTimeoutMs())}s sh -lc 'python /opt/codem/sql_judge.py' || { status=$?; if [ "$status" -eq 124 ]; then echo '${EXEC_TIMEOUT_MARKER}' >&2; exit 124; fi; exit "$status"; }`,
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
    const { passed, failed } = parseSqlRunner(capture.stdout);
    return buildJudgeResult({
      success: capture.exitCode === 0 && !capture.timedOut && !capture.outputLimitExceeded,
      passedTests: passed,
      failedTests: failed,
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
