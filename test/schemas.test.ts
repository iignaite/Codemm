import { describe, expect, it } from "vitest";
import { exampleRefs, parseExerciseYaml, parseLesson, parseRoadmapYaml, parseTrackYaml } from "../src/schemas.js";

describe("parseTrackYaml", () => {
  it("accepts an io track and clamps limits to the host ceilings", () => {
    const t = parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: /tmp/main\nlimits: { time_ms: 999999, memory_mb: 99999 }\n`);
    expect(t.limits).toEqual({ time_ms: 120000, memory_mb: 2048 });
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
    ["a learner file named README.md", `id: c\nversion: 1\nstyles: [io]\nfiles: [README.md]\nrun: x\n`, /reserved/],
    ["a learner file under tests/", `id: c\nversion: 1\nstyles: [io]\nfiles: [tests/01.in]\nrun: x\n`, /reserved/],
    ["a learner file under README.md/", `id: c\nversion: 1\nstyles: [io]\nfiles: [README.md/main.sh]\nrun: x\n`, /reserved/],
    ["a file that is also a folder", `id: c\nversion: 1\nstyles: [io]\nfiles: [lib, lib/a.sh]\nrun: x\n`, /folder/],
    ["readme.md in another case", `id: c\nversion: 1\nstyles: [io]\nfiles: [readme.md]\nrun: x\n`, /reserved/],
    ["Tests/ in another case", `id: c\nversion: 1\nstyles: [io]\nfiles: [Tests/a]\nrun: x\n`, /reserved/],
    ["a version too long to reference", `id: c\nversion: 1000000000\nstyles: [io]\nfiles: [a]\nrun: x\n`, /version/],
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
    ["a repeated prerequisite", ok.replace("requires: [c.io]", "requires: [c.io, c.io]"), /more than once/],
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
    ["a repeated concept", `slug: sum\nconcepts: [c.io, c.io]\ndifficulty: 1\n`],
  ])("rejects %s", (_label, yaml) => {
    expect(() => parseExerciseYaml(yaml)).toThrow();
  });
});

describe("roadmap sources", () => {
  const base = "goal: G\ntrack: c@1\nstyle: io\nconcepts:\n  - { id: a, title: A, requires: [] }\n";
  const withSources = (items: string) => `${base}sources:\n${items}`;

  it("accepts up to 10 https sources with short titles, and none at all", () => {
    expect(parseRoadmapYaml(base).sources).toBeUndefined();
    const r = parseRoadmapYaml(withSources('  - { title: "MDN: Loops", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration" }\n'));
    expect(r.sources).toEqual([{ title: "MDN: Loops", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Loops_and_iteration" }]);
  });

  it.each([
    ["an http link", '  - { title: T, url: "http://example.com" }\n', /https/],
    ["a javascript: link", '  - { title: T, url: "javascript:alert(1)" }\n', /https/],
    ["a link with credentials", '  - { title: T, url: "https://user:pw@example.com" }\n', /https/],
    ["a title over 120 characters", `  - { title: "${"t".repeat(121)}", url: "https://example.com" }\n`, /title/],
    ["more than 10 sources", '  - { title: T, url: "https://example.com" }\n'.repeat(11), /sources/],
    ["an unknown key", '  - { title: T, url: "https://example.com", note: x }\n', /note|Unrecognized/i],
  ])("rejects %s", (_label, items, error) => {
    expect(() => parseRoadmapYaml(withSources(items))).toThrow(error);
  });
});

describe("lesson examples", () => {
  const fence = (n: number) => "```example\n" + n + "\n```";
  const lesson = (markdown: string, examples?: Record<string, string>[]) => ({ id: "l", concept: "c", title: "L", markdown, ...(examples ? { examples } : {}) });
  const ex = { "main.sh": "echo hi\n" };

  it("finds example references: a fenced block with info string example and the example's number", () => {
    expect(exampleRefs(`Intro\n\n${fence(1)}\n\nThen\n\n${fence(2)}\n`)).toEqual([1, 2]);
    expect(exampleRefs("```sh\necho 1\n```")).toEqual([]);
  });

  it("counts only top-level example fences: not one shown inside another fence or indented, and tildes work too", () => {
    expect(exampleRefs("````md\n```example\n1\n```\n````\n")).toEqual([]);
    expect(exampleRefs("    ```example\n    1\n    ```\n")).toEqual([]);
    expect(exampleRefs("~~~example\n2\n~~~\n")).toEqual([2]);
  });

  // The app's renderer pins the same cases (desktop ui/Markdown.test.tsx): both use markdown-it's tokens.
  it.each([
      ["- item\n  ~~~text\n  code\n\n~~~example\n1\n~~~", [1]],
      ["~~~example\n1\n~~~\u00a0", []],
      ["~~~example\r1\r~~~", [1]],
      ["```example\n\n1\n\n```\n", []],
      ["```example\n1\n", []],
      ["   ````md\n```example\n1\n```\n   ````\n", []],
    ])("finds the same example blocks as the app in %j", (text, refs) => {
    expect(exampleRefs(text as string)).toEqual(refs);
  });

  it("accepts examples that are each referenced", () => {
    expect(parseLesson(lesson(`See:\n\n${fence(1)}\n`, [ex])).examples).toEqual([ex]);
    expect(parseLesson(lesson("No examples")).examples).toBeUndefined();
  });

  it.each([
    ["a reference to a missing example", lesson(`${fence(2)}\n`, [ex]), /example 2/],
    ["an example the markdown never places", lesson("Text only", [ex]), /example 1/],
    ["more than 5 examples", lesson([1, 2, 3, 4, 5, 6].map(fence).join("\n\n"), Array(6).fill(ex)), /5/],
    ["an example over 64 KB", lesson(`${fence(1)}\n`, [{ "main.sh": "x".repeat(65_537) }]), /64 KB/],
    ["more than 250 example files in all", lesson(`${fence(1)}\n\n${fence(2)}\n`, [1, 2].map((e) => Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`tests/t${e}-${i}.sh`, "x"])))), /250 files/],
  ])("refuses %s", (_label, input, error) => {
    expect(() => parseLesson(input)).toThrow(error);
  });
});
