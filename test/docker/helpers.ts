import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FileMap, readFileMap, subMap } from "../../src/files.js";
import { buildImage } from "../../src/sandbox.js";
import { parseTrackYaml } from "../../src/schemas.js";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Docker tests run when a runtime is up. CI sets CODEMM_REQUIRE_DOCKER=1 so they can never be skipped there. */
export const dockerUp = spawnSync(process.env.CODEMM_CONTAINER_CLI ?? "docker", ["info"], { stdio: "ignore" }).status === 0;
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
