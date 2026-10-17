import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CodemmError } from "./errors.js";

/**
 * The only place Codemm starts containers. Every judge run gets the same
 * host-owned isolation, whatever the track asked for.
 */

export const OUTPUT_CAP = 4 * 1024 * 1024;
export const OWNER_LABEL = "codemm=1";

export type Mount = { host: string; container: string };
export type SandboxRun = {
  image: string;
  script: string;
  env: Record<string, string>;
  mounts: Mount[];
  memoryMb: number;
  deadlineMs: number;
};
export type SandboxResult = { exit: number; stdout: Buffer; stderr: string; flooded: boolean; timedOut: boolean; cleanupFailed: boolean };

const cleanupMs = () => Number(process.env.CODEMM_CLEANUP_MS ?? 30_000);

export function containerCli(): string {
  const configured = process.env.CODEMM_CONTAINER_CLI;
  if (configured) return configured;
  for (const cli of ["docker", "podman"]) {
    if (spawnSync(cli, ["--version"], { stdio: "ignore" }).status === 0) return cli;
  }
  throw new CodemmError("No container runtime found. Install Docker Desktop (or Podman), start it and retry.");
}

/** The full `run` argument list. Pure, so the isolation flags are easy to test. */
export function sandboxArgs(run: SandboxRun, name: string, user = posixUser()): string[] {
  const args = [
    "run", "--rm", "--name", name, "--label", OWNER_LABEL, "--label", `codemm.pid=${process.pid}`,
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m",
    "--memory", `${run.memoryMb}m`, "--memory-swap", `${run.memoryMb}m`,
    "--cpus", "2", "--pids-limit", "256",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--no-healthcheck", "--log-opt", "max-size=1m",
    "--entrypoint", "/bin/sh", "--workdir", "/work/src",
    "-e", "HOME=/tmp",
  ];
  if (user) args.push("--user", user);
  for (const [k, v] of Object.entries(run.env)) args.push("-e", `${k}=${v}`);
  for (const m of run.mounts) args.push("--mount", `type=bind,source=${m.host},target=${m.container},readonly`);
  args.push(run.image, "-c", run.script);
  return args;
}

function posixUser(): string | undefined {
  return typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined;
}

export function runSandboxed(run: SandboxRun): Promise<SandboxResult> {
  const cli = containerCli();
  const name = `codemm-${randomBytes(6).toString("hex")}`;
  return new Promise((resolve) => {
    const child = spawn(cli, sandboxArgs(run, name), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let flooded = false;
    let timedOut = false;
    let cleanup: Promise<boolean> | undefined;
    // Kill the CLI, then remove the container with a bounded, checked command.
    const stop = () => {
      if (cleanup) return;
      child.kill("SIGKILL");
      cleanup = removeContainer(name);
    };
    const count = (n: number) => {
      bytes += n;
      if (bytes > OUTPUT_CAP) {
        flooded = true;
        stop();
      }
    };
    child.stdout.on("data", (b: Buffer) => {
      if (bytes + b.length <= OUTPUT_CAP) chunks.push(b);
      count(b.length);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 16_384) stderr += b.toString("utf8");
      count(b.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, run.deadlineMs);
    child.on("close", async (code) => {
      clearTimeout(timer);
      const removed = cleanup ? await cleanup : true;
      resolve({ exit: code ?? -1, stdout: Buffer.concat(chunks), stderr, flooded, timedOut, cleanupFailed: !removed });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit: -1, stdout: Buffer.alloc(0), stderr: e.message, flooded, timedOut, cleanupFailed: false });
    });
  });
}

/** `rm -f` with a deadline; true when the container is gone (including when `--rm` got there first). */
async function removeContainer(name: string): Promise<boolean> {
  const r = await cli(["rm", "-f", name], cleanupMs());
  if (r.exit === 0) return true;
  const still = await cli(["container", "inspect", name], cleanupMs());
  return still.exit !== 0 && /no such/i.test(still.output);
}

/** Runs the container CLI for housekeeping (build, inspect, remove). Not for untrusted code. */
export function cli(args: string[], timeoutMs = 60_000): Promise<{ exit: number; output: string }> {
  const bin = containerCli();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let settled = false;
    const settle = (result: { exit: number; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Settle at the deadline even if an orphaned grandchild keeps the pipes open.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A grandchild may still hold the pipes; drop them so Codemm itself can exit.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      settle({ exit: -1, output: `${output}\n(timed out after ${timeoutMs} ms)` });
    }, timeoutMs);
    child.on("close", (code) => settle({ exit: code ?? -1, output }));
    child.on("error", (e) => settle({ exit: -1, output: e.message }));
  });
}

export async function assertRuntime(): Promise<void> {
  const r = await cli(["info", "--format", "{{.ServerVersion}}"], 20_000);
  if (r.exit !== 0) throw new CodemmError("The container runtime isn't running. Start Docker Desktop (or Podman) and retry.");
}

/** Builds a track image from a staged folder. Networked; this is the separate trust boundary in DESIGN §4.4. */
export async function buildImage(contextDir: string, tag: string, timeoutMs = 600_000): Promise<{ ok: boolean; log: string }> {
  const args = ["build", "-t", tag];
  if (containerCli() === "docker") args.push("--progress", "plain");
  args.push(contextDir);
  const r = await cli(args, timeoutMs);
  return { ok: r.exit === 0, log: r.output.slice(-8000) };
}

export async function inspectImage(tag: string): Promise<{ id: string; hasVolumes: boolean } | undefined> {
  const r = await cli(["image", "inspect", "--format", "{{.Id}} {{json .Config.Volumes}}", tag]);
  if (r.exit !== 0) return undefined;
  const [id, volumes] = r.output.trim().split(" ", 2);
  return { id: id!, hasVolumes: !!volumes && volumes !== "null" && volumes !== "{}" };
}

/** Every container Codemm started, with the PID of the Codemm process that owns it. Throws if listing fails. */
export async function ownedContainers(): Promise<{ id: string; pid: number }[]> {
  const r = await cli(["ps", "-a", "--filter", `label=${OWNER_LABEL}`, "--format", '{{.ID}} {{.Label "codemm.pid"}}']);
  if (r.exit !== 0) throw new CodemmError(`Couldn't list Codemm's containers: ${r.output.trim().slice(0, 300)}`);
  return r.output.split("\n").filter((l) => l.trim()).map((l) => {
    const [id, pid] = l.trim().split(/\s+/);
    return { id: id!, pid: Number(pid) || 0 };
  });
}

/** True when the Codemm process that started a container is gone, so the container is abandoned. */
export function ownerGone(pid: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EPERM";
  }
}
