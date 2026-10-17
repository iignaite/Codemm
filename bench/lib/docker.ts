/** Docker housekeeping: track images are tagged globally, so each run removes what it created and restores what it replaced. */
import { parse } from "yaml";
import { capture } from "./proc.ts";

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
 * The docker commands that undo a run: re-tag every tag that existed before to its old image, untag the run's
 * new tags, then remove the run's images by ID. An image ID that existed before the run is never removed, and
 * neither is a new image that would still carry a tag the run didn't make.
 */
export function cleanupPlan(attempted: string[], storeIds: string[], before: Snapshot, after: Snapshot): string[][] {
  const plan: string[][] = [];
  const created = new Set<string>();
  for (const tag of new Set(attempted)) {
    const now = after.tags.get(tag);
    const old = before.tags.get(tag);
    if (now && !before.ids.has(now)) created.add(now);
    if (old && now !== old) plan.push(["tag", old, tag]);
    // Untagging the last tag of an image deletes it, so leave a new tag that points at a pre-existing image.
    else if (!old && now && created.has(now)) plan.push(["rmi", tag]);
  }
  for (const id of storeIds) if (!before.ids.has(id)) created.add(id);
  const ours = new Set(attempted);
  const kept = (id: string) => [...after.tags].some(([tag, tid]) => tid === id && !ours.has(tag));
  for (const id of created) if (!kept(id)) plan.push(["rmi", id]);
  return plan;
}

/** Runs the cleanup plan and returns what happened, for the run log. */
export function cleanupImages(attempted: string[], storeIds: string[], before: Snapshot): string[] {
  return cleanupPlan(attempted, storeIds, before, snapshot()).map((args) => {
    const ok = capture("docker", args).code === 0;
    return `${ok ? "" : "failed: "}docker ${args.map((a) => (a.startsWith("sha256:") ? a.slice(7, 19) : a)).join(" ")}`;
  });
}
