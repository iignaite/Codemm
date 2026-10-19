import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileMap } from "./files.js";
import { type RunFolder, runsDir, stageRunFolder } from "./runs.js";
import { assertRuntime, cli, containerCli, infraKind, OWNER_LABEL, ownedContainers, ownerGone, removeAbandoned, runSandboxed, runtimeKind } from "./sandbox.js";
import { codemmHome } from "./store.js";

/** A small, pinned utility image used only for the network self-test. */
const PROBE_IMAGE = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
/** The self-test's server: answers "pong" to every request on port 8080. */
const PROBE_SERVER = "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\npong' | nc -l -p 8080; done";

/** `kind`: when this computer's network, disk or container engine is the cause, as an error's kind says it (errors.ts). */
export type Check = { name: string; ok: boolean; detail: string; kind?: "offline" | "disk" | "docker" };

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/**
 * What a failed pull of the test image says about the network: DNS, a blocked or slow connection, a proxy, TLS
 * interception (an unknown certificate) or Docker Hub's rate limit all read the same to a learner: offline.
 */
const PULL_NETWORK = /no such host|server misbehaving|name resolution|could not resolve|network is unreachable|no route to host|connection (?:refused|reset)|i\/o timeout|handshake timeout|timeout exceeded|deadline exceeded|x509|certificate|toomanyrequests|rate limit|proxy|unexpected eof|failed to do request|pinging container registry|dial tcp/i;

/** A failed pull's check. Each cause says what it is; only an unknown failure stays inconclusive. */
function pullFailure(name: string, output: string): Check {
  const kind = infraKind(output);
  // The network line if there is one; else the last line, which is where a pull prints its error after the progress.
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = (lines.find((l) => PULL_NETWORK.test(l)) ?? lines.at(-1) ?? "").slice(0, 300);
  if (kind === "disk") return { name, ok: false, kind, detail: `Docker ran out of disk space downloading the test image (${line})` };
  // Codemm's own deadline (the cli's timeout text): a slow connection or a stuck engine, which the words can't tell apart.
  if (/\(timed out after \d+ ms\)/.test(output)) {
    return { name, ok: false, kind: "docker", detail: "inconclusive: Docker took more than 3 minutes to download the test image. Check the connection and that Docker is responding, then try again." };
  }
  // A stopped Podman machine refuses connections, which would read as the network.
  if (/cannot connect to podman/i.test(output)) {
    return { name, ok: false, kind: "docker", detail: `inconclusive: the container engine isn't answering (${line}). Start it, then try again.` };
  }
  // A broken credential helper is Docker's own sign-in, whatever else the line says.
  if (/error getting credentials|credential/i.test(output)) {
    return { name, ok: false, kind: "docker", detail: `Docker's sign-in helper failed while downloading the test image (${line}). Restart Docker, or run \`docker logout\`, then try again.` };
  }
  if (/toomanyrequests|rate limit/i.test(output)) {
    return { name, ok: false, kind: "offline", detail: `Docker Hub's download limit for this connection was reached (${line}). Wait a while, or sign in to Docker Hub in Docker, then try again.` };
  }
  if (/x509|certificate/i.test(output)) {
    return { name, ok: false, kind: "offline", detail: `Docker couldn't reach the network securely: a proxy or firewall may be intercepting its HTTPS connection (${line}). Connect without it or add its certificate to Docker, then try again.` };
  }
  if (kind !== "docker" && (kind === "offline" || PULL_NETWORK.test(output))) {
    return {
      name, ok: false, kind: "offline",
      detail: `Docker couldn't reach the network to download the test image (${line}). Connect to the internet, check any VPN, proxy or firewall, then try again.`,
    };
  }
  return { name, ok: false, kind: "docker", detail: `inconclusive: Docker couldn't download the test image (${line})` };
}

/** Has the test image, pulling it if it isn't here. Undefined when it's here; else the failed check. */
async function pullProbeImage(name: string): Promise<Check | undefined> {
  if ((await cli(["image", "inspect", PROBE_IMAGE])).exit === 0) return undefined;
  const pulled = await cli(["pull", PROBE_IMAGE], 180_000);
  return pulled.exit === 0 ? undefined : pullFailure(name, pulled.output);
}

/**
 * Starts a container the way a check does (the full sandbox, a staged run folder mounted read-only) and reads a file
 * back from it, so an engine that can't mount Codemm's folders fails here, not on every check. Undefined when it works.
 */
async function mountProblem(name: string): Promise<Check | undefined> {
  let folder: RunFolder;
  try {
    folder = stageRunFolder();
  } catch (e) {
    // The home isn't writable (or the disk is full): its own row says so, and the rest of doctor still runs.
    const full = (e as NodeJS.ErrnoException).code === "ENOSPC";
    return { name, ok: false, ...(full ? { kind: "disk" as const } : {}), detail: `Codemm couldn't make a folder for the test in ${codemmHome()} (${(e as Error).message.slice(0, 200)}). Check that it is writable and has free space.` };
  }
  try {
    const token = randomBytes(8).toString("hex");
    writeFileMap(join(folder.dir, "src"), { "probe.txt": token });
    const r = await runSandboxed({
      image: PROBE_IMAGE, env: {}, mounts: [{ host: join(folder.dir, "src"), container: "/work/src" }], memoryMb: 64, deadlineMs: 30_000,
      script: "cat /work/src/probe.txt",
    });
    if (r.exit === 0 && r.stdout.toString() === token) return undefined;
    const share =
      `Codemm keeps what a check mounts in ${runsDir()}. If the engine says it can't see that folder, share it with the engine ` +
      "(Colima and Rancher Desktop share only your home folder by default), then try again.";
    const reason = r.timedOut ? "it didn't finish in 30 seconds" : firstLine(r.stderr).slice(0, 300);
    // 125 is the engine refusing to start the container, -1 the CLI not starting; anything else ran, and didn't read the file.
    const started = !r.timedOut && r.exit !== 125 && r.exit !== -1;
    const detail = started
      ? `Docker mounted Codemm's folder into a container, but it couldn't read the test file there (${reason || "the folder was empty"}). ${share}`
      : `Docker couldn't start a test container with Codemm's folder mounted (${reason || `exit ${r.exit}`}). ${share}`;
    return { name, ok: false, kind: "docker", detail };
  } finally {
    folder.remove();
  }
}

/** The first IPv4 address among a container's networks, from `inspect --format '{{json .}}'`. */
function bridgeIp(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const record = JSON.parse(line) as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: unknown }> | null } };
      const ips = Object.values(record.NetworkSettings?.Networks ?? {}).map((n) => n?.IPAddress);
      return ips.find((ip): ip is string => typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
    } catch {
      // Not the record.
    }
  }
  return undefined;
}

/**
 * Proves the sandbox can't reach a server that an ordinary container can.
 * The server runs in an ordinary container, not on the host, so the host's firewall never decides the result.
 * If the ordinary container can't reach it either, nothing is proven, and that's reported as a failure.
 * Before that, it fails the way a real check would: the test image can't be downloaded (offline), or the engine
 * can't mount the folders a check stages under Codemm's home.
 */
export async function networkIsolation(): Promise<Check> {
  const name = "network isolation";
  const unusable = (await pullProbeImage(name)) ?? (await mountProblem(name));
  if (unusable) return unusable;
  // Named, so it's removed even when `run` times out before printing its id.
  const server = `codemm-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const started = await cli(["run", "-d", "--rm", "--name", server, "--label", OWNER_LABEL, "--label", `codemm.pid=${process.pid}`, PROBE_IMAGE, "sh", "-c", PROBE_SERVER], 120_000);
    if (started.exit !== 0) return { name, ok: false, detail: `inconclusive: the test server's container failed (${firstLine(started.output)})` };
    // The whole record as JSON, read here: a template that names a key one Docker version leaves out fails.
    const inspected = await cli(["inspect", "--format", "{{json .}}", server]);
    const ip = bridgeIp(inspected.output);
    if (!ip) return { name, ok: false, detail: "inconclusive: the test server's container has no bridge IP" };
    const url = `http://${ip}:8080/`;
    // A few tries, since the server's container may still be starting; wget's errors stay out of the answer.
    const control = await cli(["run", "--rm", PROBE_IMAGE, "sh", "-c", `for i in 1 2 3 4 5; do wget -q -T 2 -O- "${url}" 2>/dev/null && exit 0; sleep 1; done; exit 1`], 120_000);
    if (control.output.trim() !== "pong") {
      return { name, ok: false, detail: `inconclusive: an ordinary container couldn't reach the test server either, so isolation wasn't proven (${firstLine(control.output) || `exit ${control.exit}`})` };
    }
    const sandboxed = await runSandboxed({
      image: PROBE_IMAGE, env: {}, mounts: [], memoryMb: 64, deadlineMs: 30_000,
      script: `wget -q -T 5 -O- "${url}" && echo reached || echo blocked`,
    });
    // wget prints the server's "pong" before "reached". Anything else means the sandbox never ran its script (the
    // engine refused, or it timed out), which proves nothing either way and is no alarm about the network.
    const answer = sandboxed.stdout.toString().trim();
    if (answer === "blocked") return { name, ok: true, detail: "the sandbox can't reach a server that ordinary containers can" };
    if (answer.endsWith("reached")) return { name, ok: false, detail: "the sandbox reached the network" };
    const why = sandboxed.timedOut ? "it didn't finish in 30 seconds" : firstLine(sandboxed.stderr) || `exit ${sandboxed.exit}`;
    return { name, ok: false, kind: runtimeKind(sandboxed.stderr), detail: `inconclusive: the sandbox container didn't run its test, so isolation wasn't proven (${why.slice(0, 300)})` };
  } finally {
    await cli(["rm", "-f", server]);
  }
}

/** Abandoned containers are ones whose owning Codemm process is gone; live checks are never touched. */
async function leftovers(fix: boolean): Promise<Check> {
  const name = "leftover containers";
  let owned: { id: string; pid: number }[];
  try {
    owned = await ownedContainers();
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
  const abandoned = owned.filter((c) => ownerGone(c.pid));
  if (abandoned.length === 0) return { name, ok: true, detail: owned.length ? `none abandoned (${owned.length} in use by running checks)` : "none" };
  if (!fix) return { name, ok: false, detail: `${abandoned.length} abandoned; run codemm doctor --fix` };
  const removed = await removeAbandoned();
  return removed.left === 0
    ? { name, ok: true, detail: `removed ${removed.abandoned}` }
    : { name, ok: false, detail: `couldn't remove ${removed.left} of ${removed.abandoned}` };
}

export async function doctor(fix: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  let runtime = false;
  try {
    checks.push({ name: "container CLI", ok: true, detail: containerCli() });
    await assertRuntime();
    runtime = true;
    checks.push({ name: "container runtime", ok: true, detail: "running" });
  } catch (e) {
    checks.push({ name: "container runtime", ok: false, detail: (e as Error).message });
  }
  try {
    mkdirSync(codemmHome(), { recursive: true });
    accessSync(codemmHome(), constants.W_OK);
    checks.push({ name: "Codemm home", ok: true, detail: codemmHome() });
  } catch {
    checks.push({ name: "Codemm home", ok: false, detail: `${codemmHome()} isn't writable` });
  }
  if (!runtime) return checks;
  checks.push(await networkIsolation());
  checks.push(await leftovers(fix));
  return checks;
}
