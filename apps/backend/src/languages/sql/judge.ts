import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JudgeResult } from "../../types";
import { trace } from "../../utils/trace";
import { getJudgeTimeoutMs, runDocker, stripAnsi } from "../../judge/docker";
import { mkCodemTmpDir } from "../../judge/tmp";

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

export async function runSqlJudge(userSql: string, testSuiteJson: string): Promise<JudgeResult> {
  const start = Date.now();
  const tmp = mkCodemTmpDir("codem-sql-judge-");

  try {
    writeFileSync(join(tmp, "solution.sql"), userSql, "utf8");
    writeFileSync(join(tmp, "test_suite.json"), testSuiteJson, "utf8");

    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m,mode=1777",
      "-v",
      `${tmp}:/workspace:ro`,
      "--workdir",
      "/workspace",
      "codem-sql-judge",
    ];

    const { stdout, stderr, exitCode, timedOut } = await runDocker({ args, cwd: tmp, timeoutMs: getJudgeTimeoutMs() });
    trace("judge.result", { exitCode, timedOut, stdoutLen: stdout.length, stderrLen: stderr.length });

    const executionTimeMs = Date.now() - start;
    const { passed, failed } = parseSqlRunner(stdout);
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
