/**
 * Docker housekeeping. Track tags are global, and other sessions may build the same tags at the same time, so a
 * run records the exact image ID of every build it makes: Codemm runs Docker through a wrapper that keeps each
 * build's `--iidfile` output and adds a label unique to the run, so no other session's build can share an ID with
 * it. Cleanup removes only those IDs, by ID and never by tag, so it can't touch another session's image.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./proc.ts";

export const OWNER_LABEL = "codemm.bench.run";

/**
 * Writes a container CLI for Codemm (CODEMM_CONTAINER_CLI) into `dir`, which must be the run's own folder. Every
 * `build` also gets the run's label (so its image ID is the run's alone) and plain progress (as Codemm asks of
 * `docker`), and its image ID is copied to `dir/iid.*`: from the `--iidfile` Codemm passes, or from one the wrapper
 * adds. Every other command passes straight through. Returns the wrapper's path.
 */
export function recordingCli(dir: string, docker = capture("sh", ["-c", "command -v docker"]).out.trim()): string {
  if (!docker) throw new Error("recordingCli needs a docker executable.");
  const q = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  const path = join(dir, "docker-recorded");
  const run = randomBytes(8).toString("hex");
  const script = [
    "#!/bin/sh",
    `[ "$1" = build ] || exec ${q(docker)} "$@"`,
    "shift",
    'iid=""; prev=""',
    'for a in "$@"; do [ "$prev" = --iidfile ] && iid=$a; prev=$a; done',
    `own=${q(dir)}/iid.$$`,
    `if [ -n "$iid" ]; then ${q(docker)} build --progress plain --label ${OWNER_LABEL}=${run} "$@"; else ${q(docker)} build --progress plain --label ${OWNER_LABEL}=${run} --iidfile "$own" "$@"; fi`,
    "c=$?",
    'if [ -n "$iid" ] && [ -f "$iid" ]; then cat "$iid" > "$own"; fi',
    'exit "$c"',
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

/** The image IDs the run's builds produced, from the wrapper's `iid.*` files. */
export function builtImages(dir: string): Set<string> {
  return new Set(readdirSync(dir).filter((f) => f.startsWith("iid.")).map((f) => readFileSync(join(dir, f), "utf8").trim()).filter(Boolean));
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

/** The start of every image tag the run's Codemm home gives (core store.ts trackImageTag): `codemm-track-<home8>-`. */
export function homeTagPrefix(home: string): string {
  mkdirSync(home, { recursive: true });
  return `codemm-track-${createHash("sha256").update(realpathSync.native(home)).digest("hex").slice(0, 8)}-`;
}

/**
 * The docker commands that undo a run: `rmi` by ID for every image the run built that didn't exist before and is
 * still there, unless something other than the run's own Codemm home tagged it (`ownPrefix`), another home included.
 * Removing by ID without force can't delete another session's image, and fails rather than untag one still shared.
 */
export function cleanupPlan(built: Set<string>, before: Snapshot, after: Snapshot, ownPrefix: string): string[][] {
  const kept = (id: string) => [...after.tags].some(([tag, tid]) => tid === id && !tag.startsWith(ownPrefix));
  return [...built].filter((id) => !before.ids.has(id) && after.ids.has(id) && !kept(id)).map((id) => ["rmi", "--no-prune", id]);
}

/** Runs the cleanup plan and returns what happened, for the run log. */
export function cleanupImages(dir: string, before: Snapshot, home: string): string[] {
  return cleanupPlan(builtImages(dir), before, snapshot(), homeTagPrefix(home)).map((args) => {
    const ok = capture("docker", args).code === 0;
    return `${ok ? "" : "failed: "}docker ${args.map((a) => (a.startsWith("sha256:") ? a.slice(7, 19) : a)).join(" ")}`;
  });
}
