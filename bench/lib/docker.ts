/** Docker housekeeping: track images are tagged globally, so each run removes what it created and restores what it replaced. */
import { parse } from "yaml";
import { capture } from "./proc.ts";

export type Snapshot = { tags: Map<string, string>; ids: Set<string> };

/** Every image ID on the machine, and the `codemm-track-*` tags with their IDs. */
export function snapshot(): Snapshot {
  const ids = new Set(capture("docker", ["images", "-a", "-q", "--no-trunc"]).out.split("\n").map((l) => l.trim()).filter(Boolean));
  const tags = new Map<string, string>();
  const listed = capture("docker", ["images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}", "--filter", "reference=codemm-track-*"]).out;
  for (const line of listed.split("\n")) {
    const [tag, id] = line.trim().split(" ");
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
 * nothing is forced, so an image that still has another tag stays.
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
  for (const id of created) plan.push(["rmi", id]);
  return plan;
}

/** Runs the cleanup plan and returns what happened, for the run log. */
export function cleanupImages(attempted: string[], storeIds: string[], before: Snapshot): string[] {
  return cleanupPlan(attempted, storeIds, before, snapshot()).map((args) => {
    const ok = capture("docker", args).code === 0;
    return `${ok ? "" : "failed: "}docker ${args.map((a) => (a.startsWith("sha256:") ? a.slice(7, 19) : a)).join(" ")}`;
  });
}
