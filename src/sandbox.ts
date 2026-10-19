import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemmError, INFRA, infraError, type InfraCode } from "./errors.js";
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
  /**
   * Past this many bytes of stdout and stderr together the container is killed as a flood (default OUTPUT_CAP). The
   * result keeps at most OUTPUT_CAP of stdout either way; a caller that allows more reads it as it streams.
   */
  outputCap?: number;
};
/** `oomKilled`: the runtime recorded that the container hit its memory limit (exit 137 from inside, not a kill from outside). */
export type SandboxResult = { exit: number; stdout: Buffer; stderr: string; flooded: boolean; timedOut: boolean; cleanupFailed: boolean; oomKilled: boolean };

const cleanupMs = () => Number(process.env.CODEMM_CLEANUP_MS ?? 30_000);
/** The bound for a second ask of a silent engine, and for the runtime's answers a grade waits on. */
const SLOW_MS = 60_000;

export function containerCli(): string {
  const configured = process.env.CODEMM_CONTAINER_CLI;
  if (configured) return configured;
  for (const cli of ["docker", "podman"]) {
    if (spawnSync(cli, ["--version"], { stdio: "ignore" }).status === 0) return cli;
  }
  throw infraError(`No container runtime found. ${runtimeHelp()}`, "no-runtime");
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

/** `busy`: the engine gave no answer at all, even with more time (runtimeState). */
export type RuntimeState = "missing" | "down" | "busy" | "windows" | "ready";

/**
 * Reads the RUNTIME_INFO answer. `docker info` exits 0 even when the daemon is down, so a running
 * engine is one that reported a version.
 */
export function runtimeStateOf(r: { exit: number; output: string }): Exclude<RuntimeState, "busy"> {
  // A configured CLI that doesn't exist fails to spawn.
  if (r.exit === -1 && /ENOENT/.test(r.output)) return "missing";
  const m = /^(\S+)\|(\w+)\s*$/m.exec(r.output);
  if (r.exit !== 0 || !m) return "down";
  return m[2] === "windows" ? "windows" : "ready";
}

/** What to do about an engine that is up but doesn't answer. */
export const BUSY_HELP = "It may be busy (a large build, or Docker Desktop resuming from Resource Saver): wait a minute, then retry. If it stays this way, restart it.";

/** Why the runtime can't run checks: its code, and the message, whose last part (`help`) says what to do. */
export type RuntimeProblem = { code: InfraCode; message: string; help: string };
const problem = (code: InfraCode, lead: string, help: string): RuntimeProblem => ({ code, message: `${lead} ${help}`, help });

/** The endpoints Docker Desktop and Docker Engine use by default. Another one is a context the learner chose. */
const OWN_ENDPOINT = /^(?:unix:\/\/\/var\/run\/docker\.sock|unix:\/\/\/\S*\/\.docker\/(?:run|desktop)\/docker\.sock|npipe:\/\/\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine))$/;

/** A runtime that answered but isn't running, named from what its CLI said. */
function downProblem(output: string, platform: NodeJS.Platform): RuntimeProblem {
  if (/manually paused|docker desktop is paused/i.test(output)) return problem("runtime-paused", "Docker Desktop is paused.", "Unpause Docker Desktop from its menu, then retry.");
  if (/permission denied while trying to connect/i.test(output)) {
    return problem("socket-permission", "This user may not use the container runtime's socket.", "Add this user to the docker group (or use rootless mode), then retry.");
  }
  if (/context not found|current context .* is not found/i.test(output)) {
    return problem("runtime-context", "The Docker CLI's current context doesn't exist.", "Switch with `docker context use default` (`desktop-linux` for Docker Desktop), then retry.");
  }
  const endpoint = /Cannot connect to the Docker daemon at (\S+?)\.? Is the docker daemon running/i.exec(output)?.[1];
  if (endpoint && !OWN_ENDPOINT.test(endpoint)) {
    return problem("runtime-context", `The Docker CLI's current context points at ${endpoint}, which isn't running.`, "Start the runtime the Docker CLI's context points at, or switch with `docker context use default` (`desktop-linux` for Docker Desktop), then retry.");
  }
  return problem("runtime-down", "The container runtime isn't running.", startHelp(platform));
}

/** What an answer to RUNTIME_INFO means (null: the engine never answered), or undefined when it can run checks. */
export function runtimeIssue(answer: { exit: number; output: string } | null, platform: NodeJS.Platform = process.platform): RuntimeProblem | undefined {
  if (!answer) return problem("runtime-busy", "The container runtime isn't answering.", BUSY_HELP);
  switch (runtimeStateOf(answer)) {
    case "missing": return problem("no-runtime", "No container runtime found.", runtimeHelp(platform));
    case "down": return downProblem(answer.output, platform);
    case "windows": return problem("windows-containers", "Docker is running Windows containers.", "Switch Docker Desktop to Linux containers and retry.");
    case "ready": return undefined;
  }
}

/** What the runtime's answer means for the learner, or undefined when it can run checks. */
export function runtimeProblem(r: { exit: number; output: string }, platform: NodeJS.Platform = process.platform): string | undefined {
  return runtimeIssue(r, platform)?.message;
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
 * `end` closes the input, as end of input in a terminal does; after that, or once the container ended, it does nothing.
 */
export type StartedSandbox = {
  write(text: string): boolean;
  end(): void;
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
  const outputCap = run.outputCap ?? OUTPUT_CAP;
  const count = (n: number) => {
    bytes += n;
    if (bytes > outputCap) {
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
    if (bytes + b.length <= OUTPUT_CAP) chunks.push(b);
    if (bytes + b.length <= outputCap) tell("stdout", b);
    count(b.length);
  });
  child.stderr!.on("data", (b: Buffer) => {
    if (stderr.length < 16_384) stderr += b.toString("utf8");
    if (bytes + b.length <= outputCap) tell("stderr", b);
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
    end: () => {
      if (!ended && child.stdin?.writable) child.stdin.end();
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
  // Newer engines can publish the event after the window closes, so a miss asks once more a moment later. Only a
  // suspected kill gets here, so a plain exit never waits.
  if (await oomEventSoFar(name, startedMs)) return true;
  await new Promise((r) => setTimeout(r, OOM_RECHECK_MS));
  return oomEventSoFar(name, startedMs);
}

/** How long a missed memory-kill event waits before the runtime is asked again. */
const OOM_RECHECK_MS = 2_000;

async function oomEventSoFar(name: string, startedMs: number): Promise<boolean> {
  // Bounded like a busy engine's second answer: a memory kill the runtime is slow to report must still be graded.
  const clock = await cli(["info", "--format", "{{.SystemTime}}"], SLOW_MS);
  const now = Date.parse(clock.output.trim());
  if (clock.exit !== 0 || Number.isNaN(now)) return false;
  const at = (ms: number) => (ms / 1000).toFixed(3);
  const since = now - (Date.now() - startedMs) - 5_000;
  // The event can be published just after the exit reaches us, so the query waits until 2 s past the runtime's now.
  const r = await cli(["events", "--since", at(since), "--until", at(now + 2_000), "--filter", `container=${name}`, "--filter", "event=oom", "--format", "{{.Action}}"], SLOW_MS);
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
export function cli(args: string[], timeoutMs = 60_000, onOutput?: (text: string, stream: "stdout" | "stderr") => void): Promise<{ exit: number; output: string; timedOut?: true }> {
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
    const settle = (result: { exit: number; output: string; timedOut?: true }) => {
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
      settle({ exit: -1, output: `${output}\n(timed out after ${timeoutMs} ms)`, timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => settle({ exit: code ?? -1, output }));
    child.on("error", (e) => settle({ exit: -1, output: e.message }));
  });
}

/** Asks the engine RUNTIME_INFO within a bound: its answer, or null when none came in time. */
export type InfoAsk = (timeoutMs: number) => Promise<{ exit: number; output: string } | null>;

const askInfo: InfoAsk = async (timeoutMs) => {
  const r = await cli(RUNTIME_INFO, timeoutMs);
  return r.timedOut ? null : r;
};

/** An engine that is there but not ready: Docker Desktop answers with a server error or a dropped connection while it starts or resumes. */
const SETTLING = /Internal Server Error|Service Unavailable|Bad Gateway|\bEOF\b|connection reset by peer/i;
const settling = (answer: { exit: number; output: string } | null) => !answer || (runtimeStateOf(answer) === "down" && SETTLING.test(answer.output));

/**
 * The engine's answer to RUNTIME_INFO, or null when it never gave a real one. An engine that doesn't answer in 20 s,
 * or answers that it isn't ready, is asked once more (a few seconds later), for 60 s: under load (a large build,
 * CPU-heavy checks, Docker Desktop resuming from Resource Saver) `docker info` can take that long. One that answers,
 * even to refuse, is read at once.
 */
async function runtimeAnswer(ask: InfoAsk, pauseMs: number) {
  const first = await ask(20_000);
  if (!settling(first)) return first;
  if (first) await new Promise((r) => setTimeout(r, pauseMs));
  const second = await ask(SLOW_MS);
  return settling(second) ? null : second;
}

/** The runtime's state now: busy, not stopped, when it never gave a real answer. */
export async function runtimeState(ask: InfoAsk = askInfo, pauseMs = 5_000): Promise<RuntimeState> {
  const answer = await runtimeAnswer(ask, pauseMs);
  return answer ? runtimeStateOf(answer) : "busy";
}

/** Why the runtime can't run containers right now, or undefined when it can. */
export async function runtimeDown(ask: InfoAsk = askInfo, pauseMs = 5_000): Promise<RuntimeProblem | undefined> {
  return runtimeIssue(await runtimeAnswer(ask, pauseMs));
}

export async function assertRuntime(): Promise<void> {
  const down = await runtimeDown();
  if (down) throw infraError(down.message, down.code);
}

/** A run whose runtime stopped, or stopped answering, under it. `tail` follows "during the run". */
export function lostRun(down: RuntimeProblem, tail = ""): CodemmError {
  return infraError(`The container runtime stopped${down.code === "runtime-busy" ? " answering" : ""} during the run${tail}. ${down.help}`, down.code);
}

const NOT_THE_TRACK = "This is not a problem with the track files, so retry with the same files";

/** A build failure that isn't the track's fault: its code, and the kind that follows from it. */
export type BuildProblem = { message: string; code: InfraCode; kind: "docker" | "disk" | "offline" };
const buildIssue = (code: InfraCode, message: string): BuildProblem => ({ message, code, kind: INFRA[code] });

/** A download that ended early: Docker's pull, BuildKit's fetch. A compiler's "unexpected EOF" is the track's. */
const CUT_SHORT = /(?:failed to (?:copy|fetch|resolve|do request|authorize)|error pulling|httpReadSeeker|download failed)[^\n]*unexpected EOF/i;

/** Build output that shows the network failed, its code, and what may be behind it, in order: the first that a line shows wins. */
const NETWORK: { code: InfraCode; marker: RegExp; lead: string; why: string; retry: string }[] = [
  {
    code: "rate-limit",
    marker: /toomanyrequests|pull rate limit/i,
    lead: "The track build hit Docker Hub's pull rate limit",
    why: "Wait a few hours, or sign in to Docker Desktop for a higher limit.",
    retry: "later",
  },
  {
    code: "tls",
    // What interception looks like: a certificate no trusted authority signed. An expired certificate, or one for
    // another name, is the server's, and so the track's choice.
    marker: /certificate signed by unknown authority|self[- ]signed certificate in certificate chain|unable to get local issuer certificate/i,
    lead: "The track build couldn't verify a server's certificate",
    why: "A VPN, proxy or security software may be intercepting Docker's connections.",
    retry: "once the connection works",
  },
  {
    code: "network-timeout",
    marker: new RegExp(`i/o timeout|TLS handshake timeout|net/http: request canceled|${CUT_SHORT.source}`, "i"),
    lead: "The track build's connection timed out or dropped",
    why: "Docker may be offline, or a VPN, proxy or firewall may be slowing or blocking it.",
    retry: "once the connection works",
  },
  {
    code: "offline",
    marker: /temporary failure (?:in name resolution|resolving)|could not resolve (?:host|proxy)|no such host|network is unreachable|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|proxyconnect/i,
    lead: "The track build couldn't reach the network",
    why: "Docker may be offline, or a VPN, proxy or firewall may be blocking it.",
    retry: "once the connection works",
  },
];

/** The build log's first line that a marker matches, trimmed for a message. */
const lineOf = (log: string, marker: RegExp) => log.split("\n").find((l) => marker.test(l))?.trim().slice(0, 300);

/** Reads a failed build's output for causes outside the track: no disk space, Docker's credential helper, or the network. */
export function buildProblem(log: string): BuildProblem | undefined {
  if (/no space left on device/i.test(log)) {
    return buildIssue("docker-disk", `Docker ran out of disk space while building the track, so nothing was installed. ${NOT_THE_TRACK} ` +
      "after freeing space in Docker (`docker system prune` removes unused images and build cache), or giving Docker a larger disk.");
  }
  // Docker is running but its CLI can't run the helper that signs in to pull the base image (seen in a GUI app's PATH).
  const credentials = lineOf(log, /error getting credentials/i);
  if (credentials) {
    return buildIssue("credentials", `Docker couldn't run its credential helper (${credentials}), so nothing was installed. ${NOT_THE_TRACK} after restarting Docker Desktop.`);
  }
  for (const { code, marker, lead, why, retry } of NETWORK) {
    const line = lineOf(log, marker);
    if (line) return buildIssue(code, `${lead} (${line}), so nothing was installed. ${why} ${NOT_THE_TRACK} ${retry}.`);
  }
  // Anything else is the track's: a gate failure.
  return undefined;
}

/** The kind of problem a runtime diagnostic shows, if any: out of disk, offline, or Docker itself (doctor's checks read it). */
export function infraKind(text: string): "disk" | "offline" | "docker" | undefined {
  if (/not enough disk space|ran out of disk space|no space left on device/i.test(text)) return "disk";
  if (/couldn't reach the network|could not resolve host|network is unreachable/i.test(text)) return "offline";
  if (/container runtime|Windows containers|Cannot connect to the Docker daemon|error getting credentials|container couldn't be removed|Couldn't list Codemm's containers|container couldn't start/i.test(text)) return "docker";
  return undefined;
}

/** The kind of a runtime's own failure: what its diagnostic shows, else Docker. */
export const runtimeKind = (text: string): "disk" | "offline" | "docker" => infraKind(text) ?? "docker";

/** The code of a runtime's own failure: Docker's disk or the network when its diagnostic shows so, else `otherwise`. */
export function runtimeCode(text: string, otherwise: InfraCode): InfraCode {
  if (/no space left on device|ran out of disk space/i.test(text)) return "docker-disk";
  if (/could not resolve host|network is unreachable|no such host|temporary failure in name resolution/i.test(text)) return "offline";
  return otherwise;
}

/**
 * Why the runtime refused to start a container (`docker run` exit 125), from its CLI's error, as a fixed phrase. The
 * error itself never leaves: code that had started can write to the same stream.
 */
export function startRefusal(stderr: string): { code: InfraCode; why: string } {
  if (/range of CPUs|available CPUs|NanoCPUs/i.test(stderr)) return { code: "docker-cpus", why: "Docker has fewer than the 2 CPUs a check uses: give it more in Docker Desktop's settings" };
  if (/log[- ]opt|log(?:ging)? driver/i.test(stderr)) return { code: "docker-log-driver", why: "Docker's logging driver refused Codemm's log options: set it to json-file or local" };
  if (/mounts denied|not shared from the host|file sharing/i.test(stderr)) return { code: "docker-file-sharing", why: "Docker can't share Codemm's run folders: allow them in Docker Desktop's file sharing settings" };
  const code = runtimeCode(stderr, "container-start");
  return { code, why: code === "docker-disk" ? "Docker ran out of disk space" : code === "offline" ? "Docker couldn't reach the network" : "the runtime refused it" };
}

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
    if (r.exit === 0) return { ok: false, log, problem: buildIssue("image-id", `The container runtime built the track but didn't report the image ID. ${NOT_THE_TRACK} after updating Docker.`) };
    const down = await runtimeDown();
    const problem: BuildProblem | undefined = down ? buildIssue(down.code, down.message) : buildProblem(log);
    return { ok: false, log, ...(problem ? { problem } : {}) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * The image's id and whether it declares volumes, or undefined when the runtime says there is no such image (Docker:
 * "No such image" or "No such object"; Podman: "image not known"). Any other failure is the runtime's, and throws as one.
 */
export async function inspectImage(tag: string): Promise<{ id: string; hasVolumes: boolean } | undefined> {
  // The whole record as JSON: Docker 29 leaves Config.Volumes out when an image declares none, and a template that
  // names a missing key fails.
  const r = await cli(["image", "inspect", "--format", "{{json .}}", tag]);
  if (r.exit !== 0) {
    if (/no such (image|object)|image not known/i.test(r.output)) return undefined;
    const down = await runtimeDown();
    if (down) throw infraError(down.message, down.code);
    throw infraError(`The container runtime couldn't inspect the track image: ${r.output.trim().slice(0, 300)}`, runtimeCode(r.output, "image-inspect"));
  }
  const record = inspectRecord<{ Id?: unknown; Config?: { Volumes?: Record<string, unknown> | null } | null }>(r.output);
  // Docker answered, so this is no stopped runtime: Codemm couldn't read what it said.
  if (!record || typeof record.Id !== "string") throw infraError(`The container runtime's image record couldn't be read: ${r.output.trim().slice(0, 300)}`, "image-inspect");
  const volumes = record.Config?.Volumes;
  return { id: record.Id, hasVolumes: !!volumes && Object.keys(volumes).length > 0 };
}

/** The images a Dockerfile builds from, once each and in order: not its own stages, scratch, or an image a build argument names. */
export function baseImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) continue;
    const image = m[1]!;
    const own = stages.has(image.toLowerCase()) || image.toLowerCase() === "scratch" || image.includes("$");
    if (!own && !images.includes(image)) images.push(image);
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return images;
}

/**
 * The base images the registry says don't exist. An answer it can't give (offline, no runtime, a registry that
 * wants a login) counts nothing missing: the build then reports it.
 */
export async function missingBaseImages(dockerfile: string): Promise<string[]> {
  // Asked side by side: each answer is a registry round trip.
  const answers = await Promise.all(baseImages(dockerfile).map(async (image) => {
    try {
      const r = await cli(["manifest", "inspect", image], 30_000);
      return r.exit !== 0 && /no such manifest|manifest unknown/i.test(r.output) ? image : undefined;
    } catch {
      return undefined;
    }
  }));
  return answers.filter((image): image is string => image !== undefined);
}

/**
 * The record of `inspect --format '{{json .}}'`. Docker and Podman 4.4+ print one compact object per line, maybe among
 * warnings; Podman 4.3 and earlier print an indented array of records instead.
 */
export function inspectRecord<T>(output: string): T | undefined {
  const parse = (text: string): T | undefined => {
    try {
      const value = JSON.parse(text) as unknown;
      const record = Array.isArray(value) ? value[0] : value;
      return record && typeof record === "object" ? (record as T) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const line of output.split("\n")) {
    const record = line.trim().startsWith("{") ? parse(line) : undefined;
    if (record) return record;
  }
  const from = output.search(/[[{]/);
  return from < 0 ? undefined : parse(output.slice(from));
}

/** Every container Codemm started, with the PID of the Codemm process that owns it. Throws if listing fails. */
export async function ownedContainers(): Promise<{ id: string; pid: number }[]> {
  const r = await cli(["ps", "-a", "--filter", `label=${OWNER_LABEL}`, "--format", '{{.ID}} {{.Label "codemm.pid"}}']);
  if (r.exit !== 0) {
    // Down only when the runtime says so; anything else is a runtime that answers but failed to list.
    const down = await runtimeDown();
    if (down) throw infraError(down.message, down.code);
    throw infraError(`Couldn't list Codemm's containers: ${r.output.trim().slice(0, 300)}`, runtimeCode(r.output, "container-list"));
  }
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
