import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { assertRuntime, cli, containerCli, ownedContainers, runSandboxed } from "./sandbox.js";
import { codemmHome } from "./store.js";

/** A small, pinned utility image used only for the network self-test. */
const PROBE_IMAGE = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

export type Check = { name: string; ok: boolean; detail: string };

/** Proves the sandbox blocks a host server that an ordinary container can reach. */
async function networkIsolation(): Promise<Check> {
  const server = createServer((_req, res) => res.end("pong"));
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const control = await promisify(execFile)(
      containerCli(),
      ["run", "--rm", "--add-host", "host.docker.internal:host-gateway", PROBE_IMAGE, "sh", "-c",
        `ip=$(getent hosts host.docker.internal | cut -d' ' -f1); echo "$ip"; wget -q -T 5 -O- "http://$ip:${port}/"`],
      { timeout: 120_000 },
    ).catch(() => ({ stdout: "" }));
    const [ip, body] = control.stdout.trim().split("\n");
    if (body !== "pong") return { name: "network isolation", ok: true, detail: "skipped: an ordinary container couldn't reach the host either, so there's nothing to compare" };
    const sandboxed = await runSandboxed({
      image: PROBE_IMAGE, env: {}, mounts: [], memoryMb: 64, deadlineMs: 30_000,
      script: `wget -q -T 5 -O- "http://${ip}:${port}/" && echo reached || echo blocked`,
    });
    const blocked = sandboxed.stdout.toString().trim() === "blocked";
    return { name: "network isolation", ok: blocked, detail: blocked ? "the sandbox can't reach a host server that ordinary containers can" : "the sandbox reached the host network" };
  } finally {
    server.close();
  }
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
  const leftovers = await ownedContainers();
  if (leftovers.length > 0 && fix) {
    await cli(["rm", "-f", ...leftovers]);
    checks.push({ name: "leftover containers", ok: true, detail: `removed ${leftovers.length}` });
  } else {
    checks.push({ name: "leftover containers", ok: leftovers.length === 0, detail: leftovers.length === 0 ? "none" : `${leftovers.length} found; run codemm doctor --fix` });
  }
  return checks;
}
