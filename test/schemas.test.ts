import { describe, expect, it } from "vitest";
import { exampleRefs, LearnerEventSchema, parseExerciseYaml, parseLesson, parseRoadmapYaml, parseTrackYaml, TrackRecord } from "../src/schemas.js";

describe("check events", () => {
  const check = { format_version: 1, kind: "check", at: "2026-10-31T00:00:00Z", exercise: "e", concepts: ["a"], difficulty: 1, passed: 0, total: 102, assisted: false };

  it("reads old events without missed and ignores unknown fields", () => {
    expect(LearnerEventSchema.parse(check)).toEqual(check);
    expect(LearnerEventSchema.parse({ ...check, future: true })).toEqual(check);
  });

  it("keeps up to 50 visible names and 50 hidden indexes", () => {
    const missed = { visible: Array.from({ length: 50 }, (_, i) => `visible/${i}`), hidden: Array.from({ length: 50 }, (_, i) => i + 1) };
    expect(LearnerEventSchema.parse({ ...check, missed })).toEqual({ ...check, missed });
    expect(LearnerEventSchema.safeParse({ ...check, missed: { ...missed, visible: [...missed.visible, "extra"] } }).success).toBe(false);
    expect(LearnerEventSchema.safeParse({ ...check, missed: { ...missed, hidden: [...missed.hidden, 51] } }).success).toBe(false);
  });

  it.each([0, -1, 1.5, "hidden/secret"])("rejects a hidden index of %j", (index) => {
    expect(LearnerEventSchema.safeParse({ ...check, missed: { visible: [], hidden: [index] } }).success).toBe(false);
  });
});

describe("parseTrackYaml", () => {
  it("accepts an io track and clamps limits to the host ceilings", () => {
    const t = parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: /tmp/main\nlimits: { time_ms: 999999, memory_mb: 99999 }\n`);
    expect(t.limits).toEqual({ time_ms: 120000, memory_mb: 2048 });
  });

  it("fills default limits", () => {
    expect(parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: x\n`).limits).toEqual({ time_ms: 2000, memory_mb: 256 });
  });

  it("reads an empty build, run or test as left out", () => {
    // Codex wrote `test:` with no value on an io track, and `build:` with none on a unit track.
    expect(parseTrackYaml(`id: c\nversion: 1\nstyles: [io]\nfiles: [main.c]\nrun: x\ntest:\n`).test).toBeUndefined();
    expect(parseTrackYaml(`id: c\nversion: 1\nstyles: [unit]\nfiles: [a]\nbuild: null\ntest: x\n`).build).toBeUndefined();
    expect(() => parseTrackYaml(`id: c\nversion: 1\nstyles: [unit]\nfiles: [a]\ntest: null\n`)).toThrow(/test/);
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

describe("a WASI track's wasi block", () => {
  const SHA = "a".repeat(64);
  const yaml = (wasi: string, rest = "styles: [io]\nrun: /work/src/main.py\n") =>
    `id: py\nversion: 1\nfiles: [main.py]\n${rest}wasi:\n${wasi}`;
  const ok = `  url: https://example.org/python.zip\n  sha256: ${SHA}\n  module: python.wasm\n  dirs: { /lib: lib }\n  env: { PYTHONHOME: /, PYTHONDONTWRITEBYTECODE: "1" }\n`;

  it("accepts the block, with dirs and env optional", () => {
    expect(parseTrackYaml(yaml(ok)).wasi).toEqual({
      url: "https://example.org/python.zip", sha256: SHA, module: "python.wasm", dirs: { "/lib": "lib" }, env: { PYTHONHOME: "/", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const bare = parseTrackYaml(yaml(`  url: https://example.org/x/run.wasm\n  sha256: ${SHA}\n  module: run.wasm\n`)).wasi;
    expect(bare).toEqual({ url: "https://example.org/x/run.wasm", sha256: SHA, module: "run.wasm", dirs: {}, env: {} });
  });

  it("leaves sha256 optional: Codemm records the digest it downloads", () => {
    expect(parseTrackYaml(yaml(ok.replace(`  sha256: ${SHA}\n`, ""))).wasi?.sha256).toBeUndefined();
  });

  it.each(["https://example.org/a.tar.gz", "https://example.org/dl/a.zip?token=x"])("accepts an archive at %s", (url) => {
    expect(parseTrackYaml(yaml(ok.replace("https://example.org/python.zip", url))).wasi?.url).toBe(url);
  });

  it.each([
    ["an http url", ok.replace("https:", "http:"), /url/],
    ["a url with credentials", ok.replace("https://", "https://me:pw@"), /url/],
    ["a url of another kind of file", ok.replace("python.zip", "python.exe"), /url/],
    ["a .tar.xz url", ok.replace("python.zip", "python.tar.xz"), /url/],
    ["a url whose path doesn't name the file", ok.replace("python.zip", "dl?f=python.zip"), /url/],
    ["an uppercase sha256", ok.replace(SHA, "A".repeat(64)), /sha256/],
    ["a short sha256", ok.replace(SHA, "a".repeat(63)), /sha256/],
    ["an absolute module", ok.replace("module: python.wasm", "module: /python.wasm"), /path/i],
    ["a module outside the archive", ok.replace("module: python.wasm", "module: ../python.wasm"), /path/i],
    ["a dirs value outside the archive", ok.replace("/lib: lib", "/lib: ../lib"), /path/i],
    ["a relative dirs key", ok.replace("/lib: lib", "lib: lib"), /dirs/],
    ["the root as a dirs key", ok.replace("/lib: lib", "/: lib"), /dirs/],
    ["/work as a dirs key", ok.replace("/lib: lib", "/work: lib"), /dirs/],
    ["a dirs key under /work", ok.replace("/lib: lib", "/work/src: lib"), /dirs/],
    ["a dirs key with a .. part", ok.replace("/lib: lib", "/lib/../work: lib"), /dirs/],
    ["a dirs key with a colon", ok.replace("/lib: lib", '"/a:b": lib'), /dirs/],
    ["a dirs key with a . part", ok.replace("/lib: lib", "/lib/.: lib"), /dirs/],
    ["a dirs key with a space", ok.replace("/lib: lib", '"/my lib": lib'), /dirs/],
    ["a dirs key ending in /", ok.replace("/lib: lib", "/lib/: lib"), /dirs/],
    ["a dirs key under another", ok.replace("/lib: lib", "/lib: lib, /lib/extra: lib/x"), /under another/],
    ["the archive's root as a dirs value", ok.replace("/lib: lib", "/lib: ."), /path/i],
    ["the archive's root as the module", ok.replace("module: python.wasm", "module: ."), /path/i],
    ["a lowercase env name", ok.replace("PYTHONHOME", "pythonhome"), /env/],
    ["an env value over 1 KB", ok.replace('"1"', `"${"x".repeat(1025)}"`), /env/],
    ["more than 32 env names", ok.replace(/env: .*\n/, `env: { ${Array.from({ length: 33 }, (_, i) => `V${i}: x`).join(", ")} }\n`), /env/],
    ["a .wasm url whose module isn't its file name", `  url: https://example.org/run.wasm\n  sha256: ${SHA}\n  module: other.wasm\n`, /module/],
    ["an unknown key", `${ok}  args: x\n`, /args/],
    ["a .wasm url whose name doesn't decode", `  url: https://example.org/%E0%A4%A.wasm\n  module: x.wasm\n`, /module/],
    ["a .wasm url whose name holds a /", `  url: https://example.org/x%2Fy.wasm\n  module: x/y.wasm\n`, /module/],
  ])("rejects %s", (_label, wasi, error) => {
    expect(() => parseTrackYaml(yaml(wasi))).toThrow(error);
  });

  it.each([
    ["the unit style", "styles: [io, unit]\nrun: x\ntest: y\n", /styles must be \[io\]/],
    ["a build command", "styles: [io]\nbuild: make\nrun: x\n", /build/],
    ["a test command", "styles: [io]\nrun: x\ntest: y\n", /test/],
  ])("refuses %s", (_label, rest, error) => {
    expect(() => parseTrackYaml(yaml(ok, rest))).toThrow(error);
  });
});

describe("TrackRecord", () => {
  const base = { format_version: 1, id: "py", version: 1, styles: ["io"], files: ["main.py"], run: "x", limits: { time_ms: 2000, memory_mb: 256 }, installedAt: "now" };
  const wasi = { sha256: "a".repeat(64), module: "python.wasm", dirs: { "/lib": "lib" }, env: {} };

  it("reads a Docker track's record as before", () => {
    expect(TrackRecord.parse({ ...base, image: "codemm-track-py:1", imageId: "sha256:x" })).toMatchObject({ imageId: "sha256:x" });
  });

  it("reads a WASI track's record, which has no image", () => {
    expect(TrackRecord.parse({ ...base, wasi })).toMatchObject({ wasi });
  });

  it("refuses a WASI record whose paths a track.yaml couldn't hold", () => {
    expect(() => TrackRecord.parse({ ...base, wasi: { ...wasi, dirs: { "/x": "../.." } } })).toThrow();
    expect(() => TrackRecord.parse({ ...base, wasi: { ...wasi, dirs: { "/work": "lib" } } })).toThrow();
    expect(() => TrackRecord.parse({ ...base, wasi: { ...wasi, module: "/etc/passwd" } })).toThrow();
  });

  it("refuses a record with both engines, or neither", () => {
    expect(() => TrackRecord.parse({ ...base, image: "i", imageId: "sha256:x", wasi })).toThrow();
    expect(() => TrackRecord.parse(base)).toThrow();
    expect(() => TrackRecord.parse({ ...base, image: "i" })).toThrow();
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

describe("roadmap title", () => {
  const base = "goal: G\ntrack: c@1\nstyle: io\nconcepts:\n  - { id: a, title: A, requires: [] }\n";

  it("accepts a short display title, and none at all", () => {
    expect(parseRoadmapYaml(base).title).toBeUndefined();
    expect(parseRoadmapYaml(`title: Spring Boot\n${base}`).title).toBe("Spring Boot");
  });

  it.each([
    ["an empty title", 'title: ""\n'],
    ["a blank title", 'title: "  "\n'],
    ["a title over 60 characters", `title: "${"t".repeat(61)}"\n`],
  ])("rejects %s", (_label, line) => {
    expect(() => parseRoadmapYaml(`${line}${base}`)).toThrow(/title/);
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

describe("roadmap practice and sources", () => {
  const source = { title: "Guide", url: "https://example.com/guide" };
  const yaml = (fields: Record<string, unknown>, sources?: typeof source[]) => JSON.stringify({
    goal: "G", track: "custom@1", style: "io", concepts: [{ id: "a", title: "A", ...fields }], sources,
  });

  it("keeps optional practice, pitfalls and source refs, trimming practice", () => {
    expect(parseRoadmapYaml(yaml({ practice: "  Fix a retry loop  ", pitfalls: ["No retry budget"], refs: [0] }, [source])).concepts[0])
      .toEqual({ id: "a", title: "A", requires: [], practice: "Fix a retry loop", pitfalls: ["No retry budget"], refs: [0] });
  });

  it("accepts the limits and all ten distinct source refs", () => {
    const fields = { practice: "p".repeat(300), pitfalls: Array(5).fill("p".repeat(200)), refs: Array.from({ length: 10 }, (_, i) => i) };
    expect(parseRoadmapYaml(yaml(fields, Array(10).fill(source))).concepts[0]).toMatchObject(fields);
  });

  it.each([undefined, []])("allows practice without refs when there are no sources (%s)", (sources) => {
    expect(parseRoadmapYaml(yaml({ practice: "Fix a loop", pitfalls: [] }, sources)).concepts[0]).toMatchObject({ practice: "Fix a loop", pitfalls: [] });
  });

  it.each([
    { practice: "" }, { practice: "  " }, { practice: "p".repeat(301) },
    { pitfalls: [""] }, { pitfalls: ["p".repeat(201)] }, { pitfalls: Array(6).fill("p") },
    { refs: [-1] }, { refs: [0.5] }, { refs: ["0"] }, { refs: [0, 0] }, { refs: Array.from({ length: 11 }, (_, i) => i) },
    { extra: "unknown" },
  ])("rejects invalid concept fields %j", (fields) => {
    expect(() => parseRoadmapYaml(yaml(fields, Array(10).fill(source)))).toThrow(/Invalid roadmap:/);
  });

  it.each([undefined, [], [source]])("rejects out-of-range refs (%j)", (sources) => {
    expect(() => parseRoadmapYaml(yaml({ refs: [sources?.length ?? 0] }, sources))).toThrow(/Invalid roadmap:.*ref.*range/);
  });

  it("allows empty pitfalls without refs when sources exist", () => {
    expect(parseRoadmapYaml(yaml({ pitfalls: [] }, [source])).concepts[0]).toMatchObject({ pitfalls: [] });
  });

  it.each([{ practice: "Fix a loop" }, { pitfalls: ["No budget"] }, { practice: "Fix a loop", refs: [] }])
    ("requires refs for practice or pitfalls with sources (%j)", (fields) => {
      expect(() => parseRoadmapYaml(yaml(fields, [source]))).toThrow(/Invalid roadmap:.*ref/);
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

describe("lesson diagrams", () => {
  const lesson = (markdown: string, examples?: Record<string, string>[]) => ({ id: "l", concept: "c", title: "L", markdown, ...(examples ? { examples } : {}) });
  const diagram = "```mermaid\nflowchart TD\n  A --> B\n```";

  // The text is checked for structure only: the app draws a diagram, and shows its source if it can't (desktop §4.3).
  it("accepts diagram fences without parsing or drawing them", () => {
    expect(parseLesson(lesson(`Before\n\n${diagram}\n\nAfter`)).markdown).toContain("flowchart TD");
    expect(parseLesson(lesson("```mermaid\nthis is not a diagram\n```")).title).toBe("L");
    expect(parseLesson(lesson(`~~~mermaid\npie\n  "a" : 1\n~~~`)).id).toBe("l");
  });

  it("keeps diagrams and runnable examples apart", () => {
    const text = `${diagram}\n\n\`\`\`example\n1\n\`\`\`\n`;
    expect(exampleRefs(text)).toEqual([1]);
    expect(parseLesson(lesson(text, [{ "main.sh": "echo hi\n" }])).examples).toHaveLength(1);
    // A diagram whose only line is a number is still a diagram, not an example.
    expect(() => parseLesson(lesson("```mermaid\n1\n```", [{ "main.sh": "echo hi\n" }]))).toThrow(/example 1 is never placed/);
  });
});

describe("course styles", () => {
  const yaml = (style: string) => `goal: Learn\nstyle: ${style}\nconcepts: [{ id: a, title: A }]\n`;
  it("accepts lessons only with or without a retained track", () => {
    expect(parseRoadmapYaml(yaml("none")).track).toBeUndefined();
    expect(parseRoadmapYaml(yaml("none") + "track: example@1\n").track).toBe("example@1");
  });
  it.each(["io", "unit"])("requires a track for %s", (style) => {
    expect(() => parseRoadmapYaml(yaml(style))).toThrow(/track/);
  });
  it("keeps none out of exercise styles", () => {
    expect(() => parseExerciseYaml("slug: e\nstyle: none\nconcepts: [a]\ndifficulty: 1")).toThrow();
  });
});
