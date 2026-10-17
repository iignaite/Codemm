import { describe, expect, it } from "vitest";
import { parseExerciseYaml, parseRoadmapYaml, parseTrackYaml } from "../src/schemas.js";

describe("parseTrackYaml", () => {
  it("accepts an io track and clamps limits to the host ceilings", () => {
    const t = parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: /tmp/main\nlimits: { time_ms: 999999, memory_mb: 99999 }\n`);
    expect(t.limits).toEqual({ time_ms: 30000, memory_mb: 2048 });
  });

  it("fills default limits", () => {
    expect(parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: x\n`).limits).toEqual({ time_ms: 2000, memory_mb: 256 });
  });

  it.each([
    ["io without run", `id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\n`, /run/],
    ["unit without test", `id: c\nversion: 1\nstyles: [unit]\nfiles: [a]\n`, /test/],
    ["a bad id", `id: C!\nversion: 1\nstyles: [io]\nfiles: [a]\nrun: x\n`, /id/],
    ["an unsafe file path", `id: c\nversion: 1\nstyles: [io]\nfiles: [../a]\nrun: x\n`, /path/i],
    ["version 0", `id: c\nversion: 0\nstyles: [io]\nfiles: [a]\nrun: x\n`, /version/],
  ])("rejects %s", (_label, yaml, error) => {
    expect(() => parseTrackYaml(yaml)).toThrow(error);
  });
});

describe("parseRoadmapYaml", () => {
  const ok = `goal: Learn C\ntrack: c@1\nstyle: io\nconcepts:\n  - { id: c.io, title: Input, requires: [] }\n  - { id: c.loops, title: Loops, requires: [c.io] }\n`;

  it("accepts a valid roadmap", () => {
    expect(parseRoadmapYaml(ok).concepts.map((c) => c.id)).toEqual(["c.io", "c.loops"]);
  });

  it.each([
    ["an unpinned track", ok.replace("c@1", "c"), /track/],
    ["an unknown prerequisite", ok.replace("requires: [c.io]", "requires: [c.ptr]"), /c\.ptr/],
    ["duplicate ids", ok.replace("id: c.loops", "id: c.io"), /duplicate/i],
    ["a cycle", ok.replace("requires: []", "requires: [c.loops]"), /cycle/i],
    ["no concepts", `goal: x\ntrack: c@1\nstyle: io\nconcepts: []\n`, /concept/i],
  ])("rejects %s", (_label, yaml, error) => {
    expect(() => parseRoadmapYaml(yaml)).toThrow(error);
  });

  it("rejects oversized input before parsing", () => {
    expect(() => parseRoadmapYaml(`# ${"x".repeat(70_000)}`)).toThrow(/64 KB/);
  });
});

describe("parseExerciseYaml", () => {
  it("accepts a minimal exercise", () => {
    expect(parseExerciseYaml(`slug: sum\nconcepts: [c.io]\ndifficulty: 2\n`)).toMatchObject({ slug: "sum", difficulty: 2 });
  });

  it.each([
    ["difficulty 4", `slug: sum\nconcepts: [c.io]\ndifficulty: 4\n`],
    ["no concepts", `slug: sum\nconcepts: []\ndifficulty: 1\n`],
    ["an unknown style", `slug: sum\nconcepts: [c.io]\ndifficulty: 1\nstyle: gui\n`],
  ])("rejects %s", (_label, yaml) => {
    expect(() => parseExerciseYaml(yaml)).toThrow();
  });
});
