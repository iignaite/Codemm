import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { processAlive } from "./store.js";

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
  /** Keep the program's stdin open for typed input (`docker run -i`); Run only. */
  stdin?: boolean;
  /** Each stdout chunk as it arrives, within the output cap (for progress; the result still carries all of it). */
  onStdout?: (chunk: Buffer) => void;
};
/** `oomKilled`: the runtime recorded that the container hit its memory limit (exit 137 from inside, not a kill from outside). */
export type SandboxResult = { exit: number; stdout: Buffer; stderr: string; flooded: boolean; timedOut: boolean; cleanupFailed: boolean; oomKilled: boolean };

const cleanupMs = () => Number(process.env.CODEMM_CLEANUP_MS ?? 30_000);

export function containerCli(): string {
  const configured = process.env.CODEMM_CONTAINER_CLI;
  if (configured) return configured;
  for (const cli of ["docker", "podman"]) {
    if (spawnSync(cli, ["--version"], { stdio: "ignore" }).status === 0) return cli;
  }
  throw new CodemmError(`No container runtime found. ${runtimeHelp()}`, "docker");
}

/** What to install and start on this OS. Codemm needs an engine that runs Linux containers. */
export function runtimeHelp(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Install Docker Desktop for Mac (or Podman, experimental), start it and retry.";
  if (platform === "win32") {
    return "Install Docker Desktop for Windows with the WSL 2 backend (run `wsl --install` first if WSL 2 is missing), " +
      "make sure it's set to Linux containers, start it and retry. Podman is experimental.";
  }
  return "Install Docker Engine (or Podman, experimental), start it (for example `sudo systemctl start docker`) " +
    "and make sure your user may use it (the docker group, or rootless mode), then retry.";
}

/** How to start an installed engine that isn't running on this OS. */
export function startHelp(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin" || platform === "win32") {
    return "Start Docker Desktop (or `podman machine start` for Podman) and wait until it says it's running, then retry.";
  }
  return "Start Docker (for example `sudo systemctl start docker`) and make sure your user may use it " +
    "(the docker group, or rootless mode), then retry.";
}

/** Asks the engine for its version and the kind of containers it runs. */
export const RUNTIME_INFO = ["info", "--format", "{{.ServerVersion}}|{{.OSType}}"];

export type RuntimeState = "missing" | "down" | "windows" | "ready";

/**
 * Reads the RUNTIME_INFO answer. `docker info` exits 0 even when the daemon is down, so a running
 * engine is one that reported a version.
 */
export function runtimeStateOf(r: { exit: number; output: string }): RuntimeState {
  // A configured CLI that doesn't exist fails to spawn.
  if (r.exit === -1 && /ENOENT/.test(r.output)) return "missing";
  const m = /^(\S+)\|(\w+)\s*$/m.exec(r.output);
  if (r.exit !== 0 || !m) return "down";
  return m[2] === "windows" ? "windows" : "ready";
}

/** What the runtime's state means for the learner, or undefined when it can run checks. */
export function runtimeProblem(r: { exit: number; output: string }, platform: NodeJS.Platform = process.platform): string | undefined {
  switch (runtimeStateOf(r)) {
    case "missing": return `No container runtime found. ${runtimeHelp(platform)}`;
    case "down": return `The container runtime isn't running. ${startHelp(platform)}`;
    case "windows": return "Docker is running Windows containers. Switch Docker Desktop to Linux containers and retry.";
    case "ready": return undefined;
  }
}

/** The full `run` argument list. Pure, so the isolation flags are easy to test. */
export function sandboxArgs(run: SandboxRun, name: string, user = hostUser()): string[] {
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
    "--user", user,
  ];
  for (const [k, v] of Object.entries(run.env)) args.push("-e", `${k}=${v}`);
  for (const m of run.mounts) args.push("--mount", `type=bind,source=${m.host},target=${m.container},readonly`);
  if (run.stdin) args.push("-i");
  args.push(run.image, "-c", run.script);
  return args;
}

/** The host user on POSIX. Windows has no uid, so there the code runs as the conventional unprivileged "nobody". */
function hostUser(): string {
  return typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : "65534:65534";
}

/** Output as it arrives, within the output cap. A handler that throws is dropped; the run goes on. */
export type SandboxOutput = { stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void };

/**
 * A started container: typed input (when `stdin` is set), a kill, and its result. `write` returns false, and
 * drops the text, when it's too long, when input the program isn't reading has piled up, or after the end.
 */
export type StartedSandbox = {
  write(text: string): boolean;
  kill(): void;
  done: Promise<SandboxResult>;
  /** Whether the runtime recorded a memory-limit kill in this container, for a process inside it rather than the whole container. */
  hadOomKill(): Promise<boolean>;
};

const MAX_WRITE = 64 * 1024;
const MAX_PENDING_INPUT = 1024 * 1024;

/**
 * Starts one sandboxed container: every flag in sandboxArgs, the output cap, the host deadline and a checked
 * removal, for test runs and Run alike.
 */
export function startSandboxed(run: SandboxRun, output: SandboxOutput = {}): StartedSandbox {
  const cli = containerCli();
  const name = `codemm-${randomBytes(6).toString("hex")}`;
  const started = Date.now();
  const child = spawn(cli, sandboxArgs(run, name), { stdio: [run.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  const handlers = { ...output };
  let bytes = 0;
  let stderr = "";
  let flooded = false;
  let timedOut = false;
  let ended = false;
  let cleanup: Promise<boolean> | undefined;
  // Kill the CLI, then remove the container with a bounded, checked command.
  const stop = () => {
    ended = true;
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
  const tell = (stream: "stdout" | "stderr", b: Buffer) => {
    try {
      handlers[stream]?.(b);
    } catch {
      delete handlers[stream];
    }
  };
  child.stdout!.on("data", (b: Buffer) => {
    if (bytes + b.length <= OUTPUT_CAP) {
      chunks.push(b);
      tell("stdout", b);
    }
    count(b.length);
  });
  child.stderr!.on("data", (b: Buffer) => {
    if (stderr.length < 16_384) stderr += b.toString("utf8");
    if (bytes + b.length <= OUTPUT_CAP) tell("stderr", b);
    count(b.length);
  });
  // A program that stops reading, or exits, closes the pipe; typing after that is dropped, not an error.
  child.stdin?.on("error", () => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, run.deadlineMs);
  const done = new Promise<SandboxResult>((resolve) => {
    child.on("close", async (code) => {
      ended = true;
      clearTimeout(timer);
      // 125 is the runtime's own failure, such as a dropped connection: the container may still be running.
      if (code === 125 && !cleanup) cleanup = removeContainer(name);
      const removed = cleanup ? await cleanup : true;
      const oomKilled = code === 137 && !cleanup && (await hadOomEvent(name, started));
      resolve({ exit: code ?? -1, stdout: Buffer.concat(chunks), stderr, flooded, timedOut, cleanupFailed: !removed, oomKilled });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit: -1, stdout: Buffer.alloc(0), stderr: e.message, flooded, timedOut, cleanupFailed: false, oomKilled: false });
    });
  });
  return {
    write: (text) => {
      const stdin = child.stdin;
      const size = Buffer.byteLength(text);
      if (ended || !stdin?.writable || size > MAX_WRITE || stdin.writableLength + size > MAX_PENDING_INPUT) return false;
      stdin.write(text);
      return true;
    },
    kill: stop,
    done,
    hadOomKill: () => hadOomEvent(name, started),
  };
}

export function runSandboxed(run: SandboxRun): Promise<SandboxResult> {
  return startSandboxed(run, run.onStdout ? { stdout: run.onStdout } : {}).done;
}

/**
 * Asks the runtime whether it recorded a memory-limit kill for the container. The runtime keeps recent events
 * after `--rm` removes the container. The window is in the runtime's own clock, which may differ from the
 * host's (a VM); the container name is unique, so a few extra seconds can't match another container.
 */
async function hadOomEvent(name: string, startedMs: number): Promise<boolean> {
  const clock = await cli(["info", "--format", "{{.SystemTime}}"], 20_000);
  const now = Date.parse(clock.output.trim());
  if (clock.exit !== 0 || Number.isNaN(now)) return false;
  const at = (ms: number) => (ms / 1000).toFixed(3);
  const since = now - (Date.now() - startedMs) - 5_000;
  // The event can be published just after the exit reaches us, so the query waits until 2 s past the runtime's now.
  const r = await cli(["events", "--since", at(since), "--until", at(now + 2_000), "--filter", `container=${name}`, "--filter", "event=oom", "--format", "{{.Action}}"], 20_000);
  return r.exit === 0 && /\boom\b/.test(r.output);
}

/** `rm -f` with a deadline; true when the container is gone (including when `--rm` got there first). */
async function removeContainer(name: string): Promise<boolean> {
  const until = Date.now() + cleanupMs();
  const r = await cli(["rm", "-f", name], cleanupMs());
  if (r.exit === 0) return true;
  // `--rm` may already be removing it ("removal ... is already in progress"), so wait until it's gone.
  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    const still = await cli(["container", "inspect", name], left);
    if (still.exit !== 0 && /no such (container|object)/i.test(still.output)) return true;
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, until - Date.now()))));
  }
  return false;
}

/** Runs the container CLI for housekeeping (build, inspect, remove). Not for untrusted code. `onOutput` hears each chunk as it comes. */
export function cli(args: string[], timeoutMs = 60_000, onOutput?: (text: string, stream: "stdout" | "stderr") => void): Promise<{ exit: number; output: string }> {
  const bin = containerCli();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (stream: "stdout" | "stderr") => (b: Buffer) => {
      const text = b.toString("utf8");
      output += text;
      if (output.length > 200_000) output = output.slice(-100_000);
      onOutput?.(text, stream);
    };
    child.stdout.on("data", keep("stdout"));
    child.stderr.on("data", keep("stderr"));
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

/** Why the runtime can't run containers right now, or undefined when it can. */
export async function runtimeDown(): Promise<string | undefined> {
  return runtimeProblem(await cli(RUNTIME_INFO, 20_000));
}

export async function assertRuntime(): Promise<void> {
  const problem = await runtimeDown();
  if (problem) throw new CodemmError(problem, "docker");
}

const NOT_THE_TRACK = "This is not a problem with the track files, so retry with the same files";

/** A build failure that isn't the track's fault, and its kind. */
export type BuildProblem = { message: string; kind: "docker" | "disk" | "offline" };

/** Reads a failed build's output for causes outside the track: no network, or no disk space. */
export function buildProblem(log: string): BuildProblem | undefined {
  if (/no space left on device/i.test(log)) {
    return {
      kind: "disk",
      message: `Docker ran out of disk space while building the track, so nothing was installed. ${NOT_THE_TRACK} ` +
        "after freeing space (`docker system prune` removes unused images and build cache).",
    };
  }
  // Docker's credential helper failing (a missing or locked keychain helper) is this computer's Docker problem.
  const credentials = log.split("\n").find((l) => /error getting credentials/i.test(l));
  if (credentials) {
    return {
      kind: "docker",
      message: `Docker couldn't get registry credentials (${credentials.trim().slice(0, 300)}), so nothing was installed. ` +
        `Fix Docker's credential helper (or sign in again in Docker Desktop). ${NOT_THE_TRACK} afterwards.`,
    };
  }
  const offline = /temporary failure (?:in name resolution|resolving)|could not resolve (?:host|proxy)|no such host|network is unreachable|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)/i;
  const line = log.split("\n").find((l) => offline.test(l));
  if (line) {
    return {
      kind: "offline",
      message: `The track build couldn't reach the network (${line.trim().slice(0, 300)}), so nothing was installed. ` +
        `Docker may be offline, or a VPN, proxy or firewall may be blocking it. ${NOT_THE_TRACK} once the connection works.`,
    };
  }
  return undefined;
}

/** The kind of a runtime's own failure, from its diagnostics: out of disk when it says so, else Docker. */
export const runtimeKind = (text: string): "disk" | "docker" => (/no space left on device/i.test(text) ? "disk" : "docker");

/** A track build is killed after 10 minutes (DESIGN §4.4). */
export const BUILD_TIMEOUT_MS = 600_000;

export type BuildStep = { done: number; total: number };

/**
 * A build output line's step, as counts only: BuildKit's `#5 [2/7] RUN …` (or `[stage 2/7]`), the legacy builder's
 * `Step 2/7 :` and Podman's `STEP 2/7:`. Anything else, the step's own text included, reads as nothing.
 */
export function buildStep(line: string): BuildStep | undefined {
  // BuildKit pads the counter (`[ 2/10]`, `[builder  2/10]`); Podman names the stage (`[2/2] STEP 3/4:`).
  const m = /^(?:#\d+ \[(?:\S+\s+)?\s*(\d+)\/(\d+)\]|Step (\d+)\/(\d+) :|(?:\[\d+\/\d+\] )?STEP (\d+)\/(\d+):)/.exec(line);
  if (!m) return undefined;
  const done = Number(m[1] ?? m[3] ?? m[5]);
  const total = Number(m[2] ?? m[4] ?? m[6]);
  return done >= 1 && done <= total ? { done, total } : undefined;
}

/** Splits streamed output into lines per stream and reports each new build step. A listener that throws is dropped. */
function stepReader(listener: (step: BuildStep) => void) {
  let heard: ((step: BuildStep) => void) | undefined = listener;
  const pending = { stdout: "", stderr: "" };
  let last = "";
  return (text: string, stream: "stdout" | "stderr") => {
    const lines = (pending[stream] + text).split("\n");
    pending[stream] = lines.pop()!.slice(-1000);
    for (const line of lines) {
      const step = buildStep(line.trim());
      if (!step || `${step.done}/${step.total}` === last) continue;
      last = `${step.done}/${step.total}`;
      try {
        heard?.(step);
      } catch {
        heard = undefined;
      }
    }
  };
}

/**
 * Builds a track image from a staged folder. Networked; this is the separate trust boundary in DESIGN §4.4.
 * `imageId` is the image this build produced (`--iidfile`), so another build of the same tag in the meantime can't
 * swap it. `problem` is set when the build failed for a reason outside the track (runtime, network or disk).
 */
export async function buildImage(
  contextDir: string, tag: string, timeoutMs = BUILD_TIMEOUT_MS, onStep?: (step: BuildStep) => void,
): Promise<{ ok: boolean; log: string; imageId?: string; problem?: BuildProblem }> {
  const out = mkdtempSync(join(tmpdir(), "codemm-iid-"));
  try {
    const args = ["build", "-t", tag, "--iidfile", join(out, "iid")];
    if (containerCli() === "docker") args.push("--progress", "plain");
    args.push(contextDir);
    const r = await cli(args, timeoutMs, onStep && stepReader(onStep));
    const log = r.output.slice(-8000);
    const imageId = existsSync(join(out, "iid")) ? readFileSync(join(out, "iid"), "utf8").trim() : "";
    if (r.exit === 0 && imageId) return { ok: true, log, imageId };
    // The build worked but the runtime didn't report its image: not the track's fault.
    if (r.exit === 0) return { ok: false, log, problem: { kind: "docker", message: `The container runtime built the track but didn't report the image ID. ${NOT_THE_TRACK} after updating Docker.` } };
    const down = await runtimeDown();
    const problem: BuildProblem | undefined = down ? { kind: "docker", message: down } : buildProblem(log);
    return { ok: false, log, ...(problem ? { problem } : {}) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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
  if (r.exit !== 0) throw new CodemmError(`Couldn't list Codemm's containers: ${r.output.trim().slice(0, 300)}`, runtimeKind(r.output));
  return r.output.split("\n").filter((l) => l.trim()).map((l) => {
    const [id, pid] = l.trim().split(/\s+/);
    return { id: id!, pid: Number(pid) || 0 };
  });
}

/** True when the Codemm process that started a container is gone, so the container is abandoned. */
export const ownerGone = (pid: number): boolean => !pid || !processAlive(pid);

/**
 * Removes the containers whose owning Codemm process is gone; live ones are never touched (after a cancel or a
 * crash, and doctor --fix). Returns how many were abandoned and how many of those are still there.
 */
export async function removeAbandoned(): Promise<{ abandoned: number; left: number }> {
  const abandoned = (await ownedContainers()).filter((c) => ownerGone(c.pid));
  if (abandoned.length === 0) return { abandoned: 0, left: 0 };
  await cli(["rm", "-f", ...abandoned.map((c) => c.id)]);
  const left = (await ownedContainers()).filter((c) => abandoned.some((a) => a.id === c.id)).length;
  return { abandoned: abandoned.length, left };
}
