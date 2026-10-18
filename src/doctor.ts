import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync } from "node:fs";
import { assertRuntime, cli, containerCli, OWNER_LABEL, ownedContainers, ownerGone, removeAbandoned, runSandboxed } from "./sandbox.js";
import { codemmHome } from "./store.js";

/** A small, pinned utility image used only for the network self-test. */
const PROBE_IMAGE = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
/** The self-test's server: answers "pong" to every request on port 8080. */
const PROBE_SERVER = "while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\npong' | nc -l -p 8080; done";

export type Check = { name: string; ok: boolean; detail: string };

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/**
 * Proves the sandbox can't reach a server that an ordinary container can.
 * The server runs in an ordinary container, not on the host, so the host's firewall never decides the result.
 * If the ordinary container can't reach it either, nothing is proven, and that's reported as a failure.
 */
export async function networkIsolation(): Promise<Check> {
  const name = "network isolation";
  // Named, so it's removed even when `run` times out before printing its id.
  const server = `codemm-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const started = await cli(["run", "-d", "--rm", "--name", server, "--label", OWNER_LABEL, "--label", `codemm.pid=${process.pid}`, PROBE_IMAGE, "sh", "-c", PROBE_SERVER], 120_000);
    if (started.exit !== 0) return { name, ok: false, detail: `inconclusive: the test server's container failed (${firstLine(started.output)})` };
    const inspected = await cli(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", server]);
    const ip = inspected.output.trim().split("\n").pop() ?? "";
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { name, ok: false, detail: "inconclusive: the test server's container has no bridge IP" };
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
    const blocked = sandboxed.stdout.toString().trim() === "blocked";
    return { name, ok: blocked, detail: blocked ? "the sandbox can't reach a server that ordinary containers can" : "the sandbox reached the network" };
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
