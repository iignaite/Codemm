/** Docker housekeeping: track images are tagged globally, so each run removes what it created and restores what it replaced. */
import { capture } from "./proc.ts";

/** `codemm-track-*` tags and their image IDs. */
export function trackImages(): Map<string, string> {
  const r = capture("docker", ["images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}", "--filter", "reference=codemm-track-*"]);
  const out = new Map<string, string>();
  for (const line of r.out.split("\n")) {
    const [tag, id] = line.trim().split(" ");
    if (tag && id && !tag.includes("<none>")) out.set(tag, id);
  }
  return out;
}

/** Image tags a track file map would build: `codemm-track-<id>:<version>`, read from its track.yaml. */
export function tagForTrackYaml(yaml: string): string | undefined {
  const id = /^id:\s*["']?([a-z0-9][a-z0-9._-]*)["']?\s*$/m.exec(yaml)?.[1];
  const version = /^version:\s*["']?(\d+)["']?\s*$/m.exec(yaml)?.[1];
  return id && version ? `codemm-track-${id}:${version}` : undefined;
}

/**
 * Removes the run's track images (tags it attempted plus the image IDs its store recorded) and restores
 * any tag that existed before the bench started. Returns what it did, for the run log.
 */
export function cleanupImages(tags: string[], imageIds: string[], baseline: Map<string, string>): string[] {
  const log: string[] = [];
  const now = trackImages();
  const keep = new Set(baseline.values());
  const ids = new Set(imageIds.filter((id) => !keep.has(id)));
  for (const tag of new Set(tags)) {
    const id = now.get(tag);
    if (!id) continue;
    if (baseline.has(tag)) {
      if (baseline.get(tag) !== id) {
        ids.add(id);
        capture("docker", ["tag", baseline.get(tag)!, tag]);
        log.push(`restored ${tag}`);
      }
    } else {
      capture("docker", ["rmi", "-f", tag]);
      log.push(`removed ${tag}`);
      if (!keep.has(id)) ids.add(id);
    }
  }
  for (const id of ids) if (capture("docker", ["rmi", "-f", id]).code === 0) log.push(`removed ${id.slice(7, 19)}`);
  return log;
}
