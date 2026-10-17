import { describe, expect, it } from "vitest";
import { cleanupPlan, type Snapshot, tagForTrackYaml } from "../lib/docker.ts";

const snap = (tags: Record<string, string>, ids: string[]): Snapshot => ({ tags: new Map(Object.entries(tags)), ids: new Set(ids) });

describe("cleanupPlan", () => {
  it("restores a replaced tag and removes only the run's new image", () => {
    const before = snap({ "codemm-track-c:1": "A" }, ["A", "B"]);
    const after = snap({ "codemm-track-c:1": "N" }, ["A", "B", "N"]);
    expect(cleanupPlan(["codemm-track-c:1"], ["N"], before, after)).toEqual([["tag", "A", "codemm-track-c:1"], ["rmi", "--no-prune", "N"]]);
  });

  it("never removes an image ID that existed before the run, even if the run pointed a tag at it", () => {
    // The owner's codemm-track-y:1 is image B; the run re-tagged codemm-track-x:1 to B as well.
    const before = snap({ "codemm-track-x:1": "A", "codemm-track-y:1": "B" }, ["A", "B"]);
    const after = snap({ "codemm-track-x:1": "B", "codemm-track-y:1": "B" }, ["A", "B"]);
    expect(cleanupPlan(["codemm-track-x:1"], ["B"], before, after)).toEqual([["tag", "A", "codemm-track-x:1"]]);
  });

  it("untags a new tag and removes its image, and leaves unchanged tags alone", () => {
    const before = snap({ "codemm-track-shell-io:1": "S" }, ["S"]);
    const after = snap({ "codemm-track-shell-io:1": "S", "codemm-track-python:1": "P" }, ["S", "P"]);
    expect(cleanupPlan(["codemm-track-python:1", "codemm-track-shell-io:1"], ["P", "S"], before, after)).toEqual([["rmi", "--no-prune", "codemm-track-python:1"], ["rmi", "--no-prune", "P"]]);
  });

  it("leaves a new tag that points at a pre-existing image, since untagging could delete that image", () => {
    const before = snap({}, ["D"]);
    const after = snap({ "codemm-track-c:1": "D" }, ["D"]);
    expect(cleanupPlan(["codemm-track-c:1"], ["D"], before, after)).toEqual([]);
  });

  it("keeps a new image that something else tagged during the run", () => {
    const after = snap({ "codemm-track-c:1": "N", "someone/else:latest": "N" }, ["N"]);
    expect(cleanupPlan(["codemm-track-c:1"], ["N"], snap({}, []), after)).toEqual([["rmi", "--no-prune", "codemm-track-c:1"]]);
  });

  it("removes images of failed installs that were never recorded in the store", () => {
    const after = snap({ "codemm-track-c:2": "F" }, ["F"]);
    expect(cleanupPlan(["codemm-track-c:2", "codemm-track-c:3"], [], snap({}, []), after)).toEqual([["rmi", "--no-prune", "codemm-track-c:2"], ["rmi", "--no-prune", "F"]]);
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
