import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtImages, cleanupPlan, OWNER_LABEL, recordingCli, type Snapshot, tagForTrackYaml } from "../lib/docker.ts";

const snap = (tags: Record<string, string>, ids: string[]): Snapshot => ({ tags: new Map(Object.entries(tags)), ids: new Set(ids) });
const built = (...ids: string[]) => new Set(ids);

describe("cleanupPlan", () => {
  it("removes the run's own images by ID, never by tag", () => {
    const before = snap({ "codemm-track-c:1": "A" }, ["A"]);
    const after = snap({ "codemm-track-c:1": "N", "codemm-track-d:1": "M" }, ["A", "N", "M"]);
    expect(cleanupPlan(["codemm-track-c:1", "codemm-track-d:1"], built("N", "M"), before, after)).toEqual([["rmi", "--no-prune", "N"], ["rmi", "--no-prune", "M"]]);
  });

  it("never touches an image another session built under a tag this run tried, or one built FROM the run's image", () => {
    // This run's install of codemm-track-c:2 failed; another session built that tag (X), maybe FROM a run image.
    const after = snap({ "codemm-track-c:2": "X" }, ["X", "N"]);
    expect(cleanupPlan(["codemm-track-c:2"], built("N"), snap({}, []), after)).toEqual([["rmi", "--no-prune", "N"]]);
  });

  it("never removes an image that existed before the run, or one already gone", () => {
    expect(cleanupPlan([], built("B", "G"), snap({}, ["B"]), snap({}, ["B"]))).toEqual([]);
  });

  it("keeps a run image that a tag the run didn't try points at", () => {
    const after = snap({ "codemm-track-c:1": "N", "someone/else:latest": "N" }, ["N"]);
    expect(cleanupPlan(["codemm-track-c:1"], built("N"), snap({}, []), after)).toEqual([]);
  });
});

describe("recordingCli", () => {
  it.runIf(process.platform !== "win32")("records each build's image ID with plain progress and passes other commands through", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm bench-cli-"));
    const fake = join(dir, "fake docker");
    // A fake docker that prints its arguments and, like docker, writes the --iidfile.
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\nwhile [ $# -gt 0 ]; do [ "$1" = --iidfile ] && printf "sha256:new" > "$2"; shift; done\n');
    chmodSync(fake, 0o755);
    const cli = recordingCli(dir, fake);
    const out = (args: string[]) => spawnSync(cli, args, { encoding: "utf8" }).stdout.trim().split("\n");
    const build = out(["build", "-t", "codemm-track-c:1", "."]);
    expect(build.slice(0, 4)).toEqual(["build", "--progress", "plain", "--label"]);
    // A label unique to the run, so an identical build by another session gets a different image ID.
    expect(build[4]).toMatch(new RegExp(`^${OWNER_LABEL}=[0-9a-f]{16}$`));
    expect(build[5]).toBe("--iidfile");
    expect(build[6]!.startsWith(join(dir, "iid."))).toBe(true);
    expect(build.slice(7)).toEqual(["-t", "codemm-track-c:1", "."]);
    expect(readFileSync(build[6]!, "utf8")).toBe("sha256:new");
    expect(builtImages(dir)).toEqual(new Set(["sha256:new"]));
    expect(out(["info", "--format", "{{.OSType}}"])).toEqual(["info", "--format", "{{.OSType}}"]);
  });
});

describe("tagForTrackYaml", () => {
  it("reads id and version from any valid YAML, comments and flow style included", () => {
    expect(tagForTrackYaml("id: python # beginner track\nversion: 1\n")).toBe("codemm-track-python:1");
    expect(tagForTrackYaml('{ "id": "c", "version": 2 }')).toBe("codemm-track-c:2");
  });

  it("returns undefined for invalid YAML or a missing id or version", () => {
    expect(tagForTrackYaml("id: [")).toBeUndefined();
    expect(tagForTrackYaml("id: c\nversion: 1.5\n")).toBeUndefined();
    expect(tagForTrackYaml("version: 1\n")).toBeUndefined();
  });
});
