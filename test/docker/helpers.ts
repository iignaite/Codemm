import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FileMap, readFileMap, subMap } from "../../src/files.js";
import { buildImage, RUNTIME_INFO, runtimeProblem } from "../../src/sandbox.js";
import { parseTrackYaml } from "../../src/schemas.js";
import { tempDir } from "../temp.js";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/**
 * Docker tests run when a runtime that runs Linux containers is up (GitHub's Windows runners have
 * Docker with Windows containers only). CI sets CODEMM_REQUIRE_DOCKER=1 so they can never be skipped there.
 */
const info = spawnSync(process.env.CODEMM_CONTAINER_CLI ?? "docker", RUNTIME_INFO, { encoding: "utf8" });
export const dockerUp = runtimeProblem({ exit: info.status ?? -1, output: `${info.stdout}${info.stderr}` }) === undefined;
if (!dockerUp && process.env.CODEMM_REQUIRE_DOCKER === "1") throw new Error("CODEMM_REQUIRE_DOCKER=1 but no container runtime is running.");

export function fixtureTrack(name: string) {
  const dir = join(FIXTURES, "tracks", name);
  return { dir, files: readFileMap(dir), spec: parseTrackYaml(readFileSync(join(dir, "track.yaml"), "utf8")) };
}

export async function buildFixture(name: string): Promise<string> {
  const tag = `codemm-test-${name}:1`;
  const r = await buildImage(join(FIXTURES, "tracks", name), tag);
  if (!r.ok) throw new Error(`fixture build failed:\n${r.log}`);
  return tag;
}

/** io expected outputs from a probe's NN.out files, keyed `<set>/NN`. */
export function expectedFrom(tests: FileMap, set: "visible" | "hidden"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, v] of Object.entries(tests)) if (p.endsWith(".out")) out[`${set}/${p.slice(0, -4)}`] = v;
  return out;
}

export const inputsOnly = (tests: FileMap): FileMap => Object.fromEntries(Object.entries(tests).filter(([p]) => p.endsWith(".in")));
export { subMap };

/**
 * Routes Codemm's container calls through a wrapper that notes each bind mount's host folder, then runs the real
 * docker. `mounts()` lists those folders; `stop()` puts the plain CLI back.
 */
export function recordMounts(): { mounts(): string[]; stop(): void } {
  const dir = tempDir("codemm-mounts-");
  const log = join(dir, "mounts.log");
  const wrapper = join(dir, "docker");
  writeFileSync(wrapper, `#!/bin/sh\nfor a; do case "$a" in type=bind,*) echo "$a" >> '${log}' ;; esac; done\nexec ${process.env.CODEMM_CONTAINER_CLI ?? "docker"} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const before = process.env.CODEMM_CONTAINER_CLI;
  process.env.CODEMM_CONTAINER_CLI = wrapper;
  return {
    mounts: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []).map((m) => /^type=bind,source=(.*),target=/.exec(m)![1]!),
    stop: () => (before === undefined ? delete process.env.CODEMM_CONTAINER_CLI : (process.env.CODEMM_CONTAINER_CLI = before)),
  };
}
