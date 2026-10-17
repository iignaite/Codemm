import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { assertRuntime, cli, containerCli, ownedContainers, ownerGone, runSandboxed } from "./sandbox.js";
import { codemmHome } from "./store.js";

/** A small, pinned utility image used only for the network self-test. */
const PROBE_IMAGE = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

export type Check = { name: string; ok: boolean; detail: string };

/**
 * Proves the sandbox blocks a host server that an ordinary container can reach.
 * If the ordinary container can't reach it either, nothing is proven, and that's reported as a failure.
 */
async function networkIsolation(): Promise<Check> {
  const name = "network isolation";
  const server = createServer((_req, res) => res.end("pong"));
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    let control: { stdout: string };
    try {
      control = await promisify(execFile)(
        containerCli(),
        ["run", "--rm", "--add-host", "host.docker.internal:host-gateway", PROBE_IMAGE, "sh", "-c",
          `ip=$(getent hosts host.docker.internal | cut -d' ' -f1); echo "$ip"; wget -q -T 5 -O- "http://$ip:${port}/"`],
        { timeout: 120_000 },
      );
    } catch (e) {
      return { name, ok: false, detail: `inconclusive: the comparison container failed (${(e as Error).message.split("\n")[0]})` };
    }
    const [ip, body] = control.stdout.trim().split("\n");
    if (body !== "pong") return { name, ok: false, detail: "inconclusive: an ordinary container couldn't reach the test server either, so isolation wasn't proven" };
    const sandboxed = await runSandboxed({
      image: PROBE_IMAGE, env: {}, mounts: [], memoryMb: 64, deadlineMs: 30_000,
      script: `wget -q -T 5 -O- "http://${ip}:${port}/" && echo reached || echo blocked`,
    });
    const blocked = sandboxed.stdout.toString().trim() === "blocked";
    return { name, ok: blocked, detail: blocked ? "the sandbox can't reach a host server that ordinary containers can" : "the sandbox reached the host network" };
  } finally {
    server.close();
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
  await cli(["rm", "-f", ...abandoned.map((c) => c.id)]);
  const still = (await ownedContainers()).filter((c) => abandoned.some((a) => a.id === c.id));
  return still.length === 0
    ? { name, ok: true, detail: `removed ${abandoned.length}` }
    : { name, ok: false, detail: `couldn't remove ${still.length} of ${abandoned.length}` };
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
