/**
 * Docker housekeeping. Track images are tagged globally, and other sessions may build the same tags, so a run
 * proves which images it built: Codemm runs Docker through a wrapper that labels every build with the run's id.
 * Cleanup removes only those images and restores the tags they replaced. It never infers ownership from tags.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { capture } from "./proc.ts";

export const OWNER_LABEL = "codemm.bench.run";

/**
 * Writes a container CLI for Codemm (CODEMM_CONTAINER_CLI) that adds the run's label to every `build` and passes
 * every other command through to `docker`. Returns its path.
 */
export function labelingCli(dir: string, runId: string, docker = capture("sh", ["-c", "command -v docker"]).out.trim()): string {
  if (!/^[\w.-]+$/.test(runId) || !docker) throw new Error("labelingCli needs a plain run id and a docker executable.");
  const path = join(dir, "docker-labeled");
  const real = `'${docker.replace(/'/g, "'\\''")}'`;
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = build ]; then shift; exec ${real} build --label ${OWNER_LABEL}=${runId} "$@"; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  return path;
}

/** The IDs of every image carrying this run's label. Throws if Docker can't list them. */
export function ownedImages(runId: string): Set<string> {
  const r = capture("docker", ["images", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${runId}`]);
  if (r.code !== 0) throw new Error(`docker images failed: ${r.out.slice(0, 300)}`);
  return new Set(r.out.split("\n").map((l) => l.trim()).filter(Boolean));
}

/** Every image ID on the machine, and every tag with its image ID. */
export type Snapshot = { tags: Map<string, string>; ids: Set<string> };

/** Throws if Docker can't list images: cleanup must never run against an incomplete picture. */
export function snapshot(): Snapshot {
  const docker = (args: string[]) => {
    const r = capture("docker", args);
    if (r.code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.out.slice(0, 300)}`);
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  };
  const ids = new Set(docker(["images", "-a", "-q", "--no-trunc"]));
  const tags = new Map<string, string>();
  for (const line of docker(["images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])) {
    const [tag, id] = line.split(" ");
    if (tag && id && !tag.includes("<none>")) tags.set(tag, id);
  }
  return { tags, ids };
}

/** The image tag a track file map would build, `codemm-track-<id>:<version>`, or undefined if its track.yaml doesn't parse. */
export function tagForTrackYaml(yaml: string): string | undefined {
  try {
    const t = parse(yaml) as { id?: unknown; version?: unknown };
    return typeof t?.id === "string" && Number.isInteger(t.version) ? `codemm-track-${t.id}:${t.version}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The docker commands that undo a run. Only images this run built (`owned`, by label) and that didn't exist
 * before are touched: a tag now on one of them goes back to its old image, or is untagged if it's new, and the
 * images are then removed by ID. A run image that carries a tag the run didn't try is kept. `--no-prune` keeps
 * untagged parents.
 */
export function cleanupPlan(attempted: string[], owned: Set<string>, before: Snapshot, after: Snapshot): string[][] {
  const ours = new Set(attempted);
  const mine = (id: string | undefined) => id !== undefined && owned.has(id) && !before.ids.has(id);
  const restore: string[][] = [];
  const untag: string[][] = [];
  for (const [tag, now] of after.tags) {
    if (!mine(now) || !ours.has(tag)) continue;
    const old = before.tags.get(tag);
    if (old) restore.push(["tag", old, tag]);
    else untag.push(["rmi", "--no-prune", tag]);
  }
  // Restore first, so an untag then really removes the last tag of a run image.
  const plan = [...restore, ...untag];
  const untagged = new Set(untag.map((args) => args.at(-1)));
  const kept = (id: string) => [...after.tags].some(([tag, tid]) => tid === id && !ours.has(tag));
  // Untagging an image's last tag already removes it; remove by ID only what no untag covers.
  const covered = (id: string) => [...after.tags].some(([tag, tid]) => tid === id && untagged.has(tag));
  for (const id of owned) if (mine(id) && after.ids.has(id) && !kept(id) && !covered(id)) plan.push(["rmi", "--no-prune", id]);
  return plan;
}

/** Runs the cleanup plan and returns what happened, for the run log. */
export function cleanupImages(attempted: string[], runId: string, before: Snapshot): string[] {
  return cleanupPlan(attempted, ownedImages(runId), before, snapshot()).map((args) => {
    const ok = capture("docker", args).code === 0;
    return `${ok ? "" : "failed: "}docker ${args.map((a) => (a.startsWith("sha256:") ? a.slice(7, 19) : a)).join(" ")}`;
  });
}
