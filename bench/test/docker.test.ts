import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtImages, cleanupPlan, OWNER_LABEL, recordingCli, type Snapshot } from "../lib/docker.ts";

const snap = (tags: Record<string, string>, ids: string[]): Snapshot => ({ tags: new Map(Object.entries(tags)), ids: new Set(ids) });
const built = (...ids: string[]) => new Set(ids);

describe("cleanupPlan", () => {
  it("removes the run's own images by ID, never by tag", () => {
    const before = snap({ "codemm-track-0a1b2c3d-c:1": "A" }, ["A"]);
    const after = snap({ "codemm-track-0a1b2c3d-c:1": "A", "codemm-track-9f8e7d6c-c:1": "N", "codemm-track-9f8e7d6c-d:1": "M" }, ["A", "N", "M"]);
    expect(cleanupPlan(built("N", "M"), before, after)).toEqual([["rmi", "--no-prune", "N"], ["rmi", "--no-prune", "M"]]);
  });

  it("never touches an image another session built, or one built FROM the run's image", () => {
    const after = snap({ "codemm-track-11112222-c:2": "X" }, ["X", "N"]);
    expect(cleanupPlan(built("N"), snap({}, []), after)).toEqual([["rmi", "--no-prune", "N"]]);
  });

  it("never removes an image that existed before the run, or one already gone", () => {
    expect(cleanupPlan(built("B", "G"), snap({}, ["B"]), snap({}, ["B"]))).toEqual([]);
  });

  it("keeps a run image that something other than Codemm tagged", () => {
    const after = snap({ "codemm-track-9f8e7d6c-c:1": "N", "someone/else:latest": "N" }, ["N"]);
    expect(cleanupPlan(built("N"), snap({}, []), after)).toEqual([]);
  });
});

describe("recordingCli", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm bench-cli-"));
    const fake = join(dir, "fake docker");
    // A fake docker that prints its arguments and, like docker, writes the --iidfile.
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\nwhile [ $# -gt 0 ]; do [ "$1" = --iidfile ] && printf "sha256:new" > "$2"; shift; done\n');
    chmodSync(fake, 0o755);
    const cli = recordingCli(dir, fake);
    return { dir, out: (args: string[]) => spawnSync(cli, args, { encoding: "utf8" }).stdout.trim().split("\n") };
  };

  it.runIf(process.platform !== "win32")("keeps the ID from Codemm's own --iidfile, labels the build and prints plain progress", () => {
    const { dir, out } = setup();
    const theirs = join(dir, "codemm-iid");
    const build = out(["build", "-t", "codemm-track-c:1", "--iidfile", theirs, "."]);
    expect(build.slice(0, 4)).toEqual(["build", "--progress", "plain", "--label"]);
    // A label unique to the run, so an identical build by another session gets a different image ID.
    expect(build[4]).toMatch(new RegExp(`^${OWNER_LABEL}=[0-9a-f]{16}$`));
    expect(build.slice(5)).toEqual(["-t", "codemm-track-c:1", "--iidfile", theirs, "."]);
    expect(builtImages(dir)).toEqual(new Set(["sha256:new"]));
  });

  it.runIf(process.platform !== "win32")("adds its own --iidfile when the build has none, and passes other commands through", () => {
    const { dir, out } = setup();
    const build = out(["build", "-t", "codemm-track-c:1", "."]);
    expect(build[5]).toBe("--iidfile");
    expect(build[6]!.startsWith(join(dir, "iid."))).toBe(true);
    expect(readFileSync(build[6]!, "utf8")).toBe("sha256:new");
    expect(builtImages(dir)).toEqual(new Set(["sha256:new"]));
    expect(out(["info", "--format", "{{.OSType}}"])).toEqual(["info", "--format", "{{.OSType}}"]);
  });
});
