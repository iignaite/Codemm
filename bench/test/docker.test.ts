import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupPlan, labelingCli, OWNER_LABEL, type Snapshot, tagForTrackYaml } from "../lib/docker.ts";

const snap = (tags: Record<string, string>, ids: string[]): Snapshot => ({ tags: new Map(Object.entries(tags)), ids: new Set(ids) });
const owned = (...ids: string[]) => new Set(ids);

describe("cleanupPlan", () => {
  it("restores a replaced tag and removes the run's own image", () => {
    const before = snap({ "codemm-track-c:1": "A" }, ["A", "B"]);
    const after = snap({ "codemm-track-c:1": "N" }, ["A", "B", "N"]);
    expect(cleanupPlan(["codemm-track-c:1"], owned("N"), before, after)).toEqual([["tag", "A", "codemm-track-c:1"], ["rmi", "--no-prune", "N"]]);
  });

  it("never touches an image another session built under a tag this run tried", () => {
    // This run's install of codemm-track-c:2 failed; meanwhile another session built that tag (image X, not ours).
    const after = snap({ "codemm-track-c:2": "X" }, ["X"]);
    expect(cleanupPlan(["codemm-track-c:2"], owned(), snap({}, []), after)).toEqual([]);
    // Same when this run had replaced an older image under the tag: the other session's image stays as it is.
    expect(cleanupPlan(["codemm-track-c:2"], owned(), snap({ "codemm-track-c:2": "A" }, ["A"]), after)).toEqual([]);
  });

  it("never removes an image that existed before the run", () => {
    const before = snap({ "codemm-track-x:1": "A", "codemm-track-y:1": "B" }, ["A", "B"]);
    const after = snap({ "codemm-track-x:1": "B", "codemm-track-y:1": "B" }, ["A", "B"]);
    expect(cleanupPlan(["codemm-track-x:1"], owned("B"), before, after)).toEqual([]);
  });

  it("untags the run's new tag, which removes its image, and leaves other tags alone", () => {
    const before = snap({ "codemm-track-shell-io:1": "S" }, ["S"]);
    const after = snap({ "codemm-track-shell-io:1": "S", "codemm-track-python:1": "P" }, ["S", "P"]);
    expect(cleanupPlan(["codemm-track-python:1", "codemm-track-shell-io:1"], owned("P"), before, after)).toEqual([["rmi", "--no-prune", "codemm-track-python:1"]]);
  });

  it("restores tags before untagging, so a run image shared by both is removed", () => {
    const before = snap({ "codemm-track-old:1": "A" }, ["A"]);
    const after = snap({ "codemm-track-new:1": "B", "codemm-track-old:1": "B" }, ["A", "B"]);
    expect(cleanupPlan(["codemm-track-new:1", "codemm-track-old:1"], owned("B"), before, after)).toEqual([
      ["tag", "A", "codemm-track-old:1"],
      ["rmi", "--no-prune", "codemm-track-new:1"],
    ]);
  });

  it("keeps a run image that something else tagged during the run", () => {
    const after = snap({ "codemm-track-c:1": "N", "someone/else:latest": "N" }, ["N"]);
    expect(cleanupPlan(["codemm-track-c:1"], owned("N"), snap({}, []), after)).toEqual([["rmi", "--no-prune", "codemm-track-c:1"]]);
  });

  it("removes the run's untagged images, such as failed installs", () => {
    expect(cleanupPlan([], owned("U"), snap({}, []), snap({}, ["U"]))).toEqual([["rmi", "--no-prune", "U"]]);
  });
});

describe("labelingCli", () => {
  it.runIf(process.platform !== "win32")("labels every build with the run's id and passes other commands through", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-bench-cli-"));
    const fake = join(dir, "fake-docker");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(fake, 0o755);
    const cli = labelingCli(dir, "run-123", fake);
    const out = (args: string[]) => spawnSync(cli, args, { encoding: "utf8" }).stdout.trim().split("\n");
    expect(out(["build", "-t", "codemm-track-c:1", "."])).toEqual(["build", "--label", `${OWNER_LABEL}=run-123`, "-t", "codemm-track-c:1", "."]);
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
