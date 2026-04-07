import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runDocker } from "../../judge/docker";
import { writeUserFiles } from "../../judge/files";
import { inferClassName } from "../../utils/javaCodegen";
import { mkCodemTmpDir } from "../../judge/tmp";

function getRunTimeoutMs(): number {
  const raw = process.env.CODEMM_RUN_TIMEOUT_MS;
  if (!raw) return 8000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 8000;
  // Hard cap to avoid runaway local resource use.
  return Math.min(Math.floor(n), 30_000);
}

export type RunResult = {
  stdout: string;
  stderr: string;
};

export type JavaFiles = Record<string, string>;

function assertSafeJavaMainClassName(mainClass: string): string {
  const trimmed = mainClass.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid mainClass "${mainClass}".`);
  }
  return trimmed;
}

function hasJavaMainMethod(source: string): boolean {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");
  return /public\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:(?:\[\s*\]|\.\.\.)\s*\w+|\w+\s*\[\s*\])\s*\)/.test(
    withoutLineComments
  );
}

function inferMainClassFromFiles(files: JavaFiles): string | null {
  for (const [filename, source] of Object.entries(files)) {
    if (!hasJavaMainMethod(source)) continue;
    const fallback = filename.replace(/\.java$/i, "") || "Main";
    return inferClassName(source, fallback);
  }
  return null;
}

export async function runJavaFiles(opts: {
  files: JavaFiles;
  mainClass?: string;
  stdin?: string;
}): Promise<RunResult> {
  const tmp = mkCodemTmpDir("codem-run-");

  try {
    writeUserFiles(tmp, opts.files);

    const inferred = opts.mainClass ?? inferMainClassFromFiles(opts.files);
    const mainClass = inferred ? assertSafeJavaMainClassName(inferred) : null;
    if (!mainClass) {
      return {
        stdout: "",
        stderr:
          "No runnable Java entrypoint found. Add `public static void main(String[] args)` to a class, or specify mainClass.",
      };
    }

    const hasStdin = typeof opts.stdin === "string";
    if (hasStdin) {
      writeFileSync(join(tmp, "stdin.txt"), opts.stdin ?? "", "utf8");
    }

    const runCmd = hasStdin ? `java -cp /tmp/classes ${mainClass} < /workspace/stdin.txt` : `java -cp /tmp/classes ${mainClass}`;

    // Reuse the existing judge image, but override ENTRYPOINT so it doesn't run JUnit.
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
      `mkdir -p /tmp/classes && javac -d /tmp/classes /workspace/*.java && ${runCmd}`,
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

/**
 * Terminal-style execution: compile + run user code only.
 *
 * - No test suite
 * - No persistence
 * - Uses the existing codem-java-judge image but overrides entrypoint
 */
export async function runJavaCodeOnly(userCode: string, stdin?: string): Promise<RunResult> {
  const userClassName = inferClassName(userCode, "Solution");
  const opts: { files: JavaFiles; mainClass: string; stdin?: string } = {
    files: { [`${userClassName}.java`]: userCode },
    mainClass: userClassName,
  };
  if (typeof stdin === "string") {
    opts.stdin = stdin;
  }
  return runJavaFiles(opts);
}
