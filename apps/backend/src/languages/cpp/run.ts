import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runDocker } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { mkCodemTmpDir } from "../../judge/tmp";

function getRunTimeoutMs(): number {
  const raw = process.env.CODEMM_RUN_TIMEOUT_MS;
  if (!raw) return 8000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 8000;
  return Math.min(Math.floor(n), 30_000);
}

export type RunResult = {
  stdout: string;
  stderr: string;
};

export type CppFiles = Record<string, string>;

export async function runCppFiles(opts: { files: CppFiles; stdin?: string }): Promise<RunResult> {
  const tmp = mkCodemTmpDir("codem-cpp-run-");

  try {
    writeUserFiles(tmp, opts.files);

    if (!Object.prototype.hasOwnProperty.call(opts.files, "main.cpp")) {
      return {
        stdout: "",
        stderr: 'C++ /run requires a "main.cpp" file.',
      };
    }

    const hasStdin = typeof opts.stdin === "string";
    if (hasStdin) {
      writeFileSync(join(tmp, "stdin.txt"), opts.stdin ?? "", "utf8");
    }

    const compileCmd =
      "g++ -std=c++20 -O2 -pipe -Wall -Wextra -Wno-unused-parameter -o /tmp/a.out *.cpp";
    const runCmd = hasStdin ? "/tmp/a.out < /workspace/stdin.txt" : "/tmp/a.out";

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

    const { stdout, stderr } = await runDocker({ args, cwd: tmp, timeoutMs: getRunTimeoutMs() });
    return { stdout, stderr };
  } catch (e: any) {
    return {
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? String(e?.error ?? e),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runCppCodeOnly(userCode: string, stdin?: string): Promise<RunResult> {
  const files: CppFiles = { "main.cpp": userCode };
  return runCppFiles({ files, ...(typeof stdin === "string" ? { stdin } : {}) });
}
