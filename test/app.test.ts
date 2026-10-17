import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { parseTrackYaml } from "../src/schemas.js";
import type { LearnerEvent } from "../src/learner.js";
import * as store from "../src/store.js";
import { fakeDocker } from "./fake-docker.js";

/** Use cases that need no container runtime: tracks and exercises are written straight into the store. */

let ws: string;
beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", mkdtempSync(join(tmpdir(), "codemm-home-")));
  ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function installFake(ref = "shell-io@1", styles: ("io" | "unit")[] = ["io"]): void {
  const { id, version } = store.parseTrackRef(ref);
  store.writeTrackRecord(ref, {
    format_version: 1, id, version, styles, files: ["main.sh"], run: "sh main.sh",
    limits: { time_ms: 2000, memory_mb: 256 }, image: `codemm-track-${id}:${version}`, imageId: "sha256:fake", installedAt: new Date().toISOString(),
  });
}

function addExercise(course: string, slug: string, concept: string, track = "shell-io@1"): void {
  store.commitFolder(
    store.exerciseDir(course, slug),
    { "README.md": "Print the max.", "starter/main.sh": "echo todo\n", "solution/main.sh": "SECRET-SOLUTION\n", "tests/visible/01.in": "3 1 2\n", "tests/hidden/01.in": "HIDDEN-INPUT\n" },
    {
      "exercise.json": {
        format_version: 1, slug, style: "io", concepts: [concept], difficulty: 1, track, createdAt: new Date().toISOString(),
        expected: { "visible/01": "3\n", "hidden/01": "HIDDEN-OUTPUT\n" },
      },
    },
  );
}

const event = (e: Record<string, unknown>) => ({ format_version: 1, at: new Date().toISOString(), ...e }) as LearnerEvent;

const roadmap = (concepts = "  - { id: sh.basics, title: Basics, requires: [] }\n  - { id: sh.loops, title: Loops, requires: [sh.basics] }\n", track = "shell-io@1") =>
  `goal: Shell basics\ntrack: ${track}\nstyle: io\nconcepts:\n${concepts}`;

describe("roadmap draft", () => {
  it("saves a roadmap before its track is installed and asks for setup", async () => {
    expect(await app.saveRoadmap(ws, "shell", roadmap())).toEqual({ course: "shell", concepts: 2 });
    expect(app.nextStep(ws)).toEqual({ kind: "setup", track: "shell-io@1" });
    installFake();
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", concept: "sh.basics", title: "Basics", difficulty: 1, lesson: null, style: "io", track: "shell-io@1" });
  });

  it("refuses a style the installed track doesn't offer, at save and at next_step", async () => {
    installFake("shell-io@1", ["unit"]);
    await expect(app.saveRoadmap(ws, "shell", roadmap())).rejects.toThrow(/style/);
    await app.saveRoadmap(ws, "shell", roadmap(undefined, "shell-io@2"));
    installFake("shell-io@2", ["unit"]);
    expect(() => app.nextStep(ws)).toThrow(/Edit the roadmap's style/);
  });

  it("returns the roadmap as saved", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    expect(app.getRoadmap(ws)).toEqual({
      course: "shell", goal: "Shell basics", track: "shell-io@1", style: "io",
      concepts: [{ id: "sh.basics", title: "Basics", requires: [] }, { id: "sh.loops", title: "Loops", requires: ["sh.basics"] }],
    });
  });

  it("takes renames, moves, additions and removals that keep ids and prerequisites", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    const edited = "  - { id: sh.basics, title: First steps, requires: [] }\n  - { id: sh.vars, title: Variables, requires: [] }\n";
    await app.saveRoadmap(ws, "shell", roadmap(edited));
    expect(app.getRoadmap(ws).concepts).toEqual([
      { id: "sh.basics", title: "First steps", requires: [] },
      { id: "sh.vars", title: "Variables", requires: [] },
    ]);
  });

  it("refuses to remove a concept another one requires", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    await expect(app.saveRoadmap(ws, "shell", roadmap("  - { id: sh.loops, title: Loops, requires: [sh.basics] }\n"))).rejects.toThrow(/unknown concept "sh.basics"/);
  });

  it.each([
    ["an event", () => store.appendEvent("shell", event({ kind: "skip", concept: "sh.loops" }))],
    ["an exercise", () => addExercise("shell", "e1", "sh.loops")],
  ])("refuses to remove a concept used by %s", async (_label, use) => {
    installFake();
    await app.saveRoadmap(ws, "shell", roadmap());
    use();
    await expect(app.saveRoadmap(ws, "shell", roadmap("  - { id: sh.basics, title: Basics, requires: [] }\n"))).rejects.toThrow(/sh\.loops/);
  });

  it("can change track until the course has an exercise", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    await app.saveRoadmap(ws, "shell", roadmap(undefined, "bash@1"));
    expect(app.getRoadmap(ws).track).toBe("bash@1");
    installFake("bash@1");
    addExercise("shell", "e1", "sh.basics", "bash@1");
    await expect(app.saveRoadmap(ws, "shell", roadmap())).rejects.toThrow(/has exercises/);
  });

  it("gives a stuck concept a fresh start when it gains a prerequisite", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    for (let i = 0; i < 2; i++) store.appendEvent("shell", event({ kind: "check", exercise: "e1", concepts: ["sh.loops"], difficulty: 1, passed: 0, total: 1, assisted: false }));
    const withPrereq = "  - { id: sh.basics, title: Basics, requires: [] }\n  - { id: sh.vars, title: Variables, requires: [] }\n  - { id: sh.loops, title: Loops, requires: [sh.basics, sh.vars] }\n";
    await app.saveRoadmap(ws, "shell", roadmap(withPrereq));
    expect(store.readEvents("shell").at(-1)).toMatchObject({ kind: "retry", concept: "sh.loops" });
    // Saving again adds no prerequisite, so there is no second retry.
    await app.saveRoadmap(ws, "shell", roadmap(withPrereq));
    expect(store.readEvents("shell").filter((e) => e.kind === "retry")).toHaveLength(1);
  });
});

describe("the author step", () => {
  it("gives a fresh author the exact target and the installed track's learner-safe contract", async () => {
    const files = readFileMap(join(import.meta.dirname, "fixtures", "tracks", "custom-unit"));
    const spec = parseTrackYaml(files["track.yaml"]!);
    store.commitFolder(store.trackDir("custom-unit@1"), files, {
      "track.json": { format_version: 1, ...spec, image: "codemm-track-custom-unit:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
    });
    await app.saveRoadmap(ws, "calc", "goal: Calculator\ntrack: custom-unit@1\nstyle: unit\nconcepts:\n  - { id: calc.add, title: Adding numbers, requires: [] }\n");
    expect(app.nextStep(ws)).toEqual({
      kind: "author", concept: "calc.add", title: "Adding numbers", difficulty: 1, lesson: null, style: "unit", track: "custom-unit@1",
      contract: {
        files: ["src/calc.funcs"],
        test: "sh /opt/judge/run-checks",
        limits: { time_ms: 5000, memory_mb: 128 },
        examples: {
          solution: { "src/calc.funcs": files["probe/unit/pass/src/calc.funcs"] },
          tests: { "negatives.check": files["probe/unit/tests/negatives.check"], "sums.check": files["probe/unit/tests/sums.check"] },
        },
      },
    });
  });
});

describe("reviews", () => {
  it("shows when a mastered concept's review is due, and asks for it once due", async () => {
    installFake();
    await app.saveRoadmap(ws, "shell", roadmap());
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (let i = 0; i < 4; i++) {
      store.appendEvent("shell", event({ kind: "check", at: twoDaysAgo, exercise: `e${i}`, concepts: ["sh.basics"], difficulty: 1, passed: 1, total: 1, assisted: false }));
    }
    const due = new Date(Date.parse(twoDaysAgo) + 86_400_000).toISOString();
    expect(app.progress(ws).concepts[0]).toMatchObject({ id: "sh.basics", mastered: true, reviewDue: due });
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", concept: "sh.basics", difficulty: 3, review: true, title: "Basics" });
  });
});

describe("lessons", () => {
  const lesson = (id: string, concept = "sh.basics") => ({ id, concept, title: `About ${id}`, markdown: `# ${id}\n\nText.` });

  beforeEach(async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
  });

  it("saves a lesson before the track is installed, and reads it with notes", async () => {
    expect(await app.saveLesson(ws, lesson("intro"))).toEqual({ lesson: "intro" });
    expect(app.getLesson(ws, "intro")).toEqual({ id: "intro", concept: "sh.basics", title: "About intro", markdown: "# intro\n\nText.", notes: "" });
    await app.saveNotes(ws, "intro", "remember $1");
    expect(app.getLesson(ws, "intro").notes).toBe("remember $1");
    const record = JSON.parse(readFileSync(join(process.env.CODEMM_HOME!, "courses", "shell", "lessons", "intro", "lesson.json"), "utf8"));
    expect(record).toMatchObject({ format_version: 1, id: "intro", concept: "sh.basics" });
  });

  it.each([
    ["a taken id", () => lesson("intro"), /already used/],
    ["a concept outside the roadmap", () => lesson("x", "sh.nope"), /not in the roadmap/],
    ["more than 64 KB", () => ({ ...lesson("big"), markdown: "x".repeat(65_537) }), /64 KB/],
    ["an unsafe id", () => lesson("../up"), /id/],
  ])("refuses %s", async (_label, input, error) => {
    await app.saveLesson(ws, lesson("intro"));
    await expect(app.saveLesson(ws, input())).rejects.toThrow(error);
  });

  it("refuses notes over 64 KB and notes on a missing lesson", async () => {
    await app.saveLesson(ws, lesson("intro"));
    await expect(app.saveNotes(ws, "intro", "x".repeat(65_537))).rejects.toThrow(/64 KB/);
    await expect(app.saveNotes(ws, "nope", "x")).rejects.toThrow(/No lesson/);
  });

  it("records a read only on acknowledgement, and only once", async () => {
    await app.saveLesson(ws, lesson("intro"));
    app.getLesson(ws, "intro");
    expect(store.readEvents("shell")).toEqual([]);
    await app.markLessonRead(ws, "intro");
    await app.markLessonRead(ws, "intro");
    expect(store.readEvents("shell")).toEqual([expect.objectContaining({ kind: "read", lesson: "intro", concept: "sh.basics" })]);
    expect(app.listLessons(ws)).toEqual([{ id: "intro", concept: "sh.basics", title: "About intro", created: expect.any(String), read: true }]);
  });

  it("asks for a lesson, then the earliest unread one, before practice", async () => {
    installFake();
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", lesson: null });
    await app.saveLesson(ws, lesson("intro"));
    await app.saveLesson(ws, lesson("more"));
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", lesson: "intro" });
    await app.markLessonRead(ws, "intro");
    await app.markLessonRead(ws, "more");
    expect(app.nextStep(ws)).not.toHaveProperty("lesson");
  });

  it("keeps a concept a lesson uses in the roadmap", async () => {
    await app.saveLesson(ws, lesson("loops", "sh.loops"));
    await expect(app.saveRoadmap(ws, "shell", roadmap("  - { id: sh.basics, title: Basics, requires: [] }\n"))).rejects.toThrow(/sh\.loops/);
  });
});

describe("exercise list", () => {
  it("lists exercises with what a job's done check needs, and nothing hidden", async () => {
    installFake();
    await app.saveRoadmap(ws, "shell", roadmap());
    addExercise("shell", "e1", "sh.basics");
    const list = app.listExercises(ws);
    expect(list).toEqual([{ exercise: "e1", concepts: ["sh.basics"], difficulty: 1, created: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toMatch(/SECRET|HIDDEN/);
  });
});

describe("learner files", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const file = () => join(ws, "exercises", "shell", "e1", "main.sh");

  beforeEach(async () => {
    installFake();
    await app.saveRoadmap(ws, "shell", roadmap());
    addExercise("shell", "e1", "sh.basics");
  });

  it("reads only the exercise's track files, with digests", () => {
    const files = app.readLearnerFiles(ws, "e1");
    expect(files).toEqual({ "main.sh": { text: "echo todo\n", digest: sha("echo todo\n") } });
    expect(JSON.stringify(files)).not.toMatch(/SECRET|HIDDEN/);
  });

  it("saves a file loaded with the current digest, and refuses a stale one", async () => {
    const { digest } = app.readLearnerFiles(ws, "e1")["main.sh"]!;
    expect(await app.writeLearnerFile(ws, "e1", "main.sh", "echo 3\n", digest)).toEqual({ digest: sha("echo 3\n") });
    expect(readFileSync(file(), "utf8")).toBe("echo 3\n");
    await expect(app.writeLearnerFile(ws, "e1", "main.sh", "echo 4\n", digest)).rejects.toThrow(/Changed outside Codemm/);
    expect(readFileSync(file(), "utf8")).toBe("echo 3\n");
  });

  it("refuses files that aren't the exercise's track files", async () => {
    app.readLearnerFiles(ws, "e1");
    await expect(app.writeLearnerFile(ws, "e1", "README.md", "x", sha("Print the max."))).rejects.toThrow(/isn't one of/);
    await expect(app.writeLearnerFile(ws, "e1", "../e2/main.sh", "x", sha("x"))).rejects.toThrow(/isn't one of/);
  });

  it.runIf(process.platform !== "win32")("refuses to write through a symlink", async () => {
    app.readLearnerFiles(ws, "e1");
    const outside = join(mkdtempSync(join(tmpdir(), "codemm-outside-")), "target.sh");
    writeFileSync(outside, "echo todo\n");
    rmSync(file());
    symlinkSync(outside, file());
    await expect(app.writeLearnerFile(ws, "e1", "main.sh", "echo 3\n", sha("echo todo\n"))).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("echo todo\n");
  });
});

describe("setup proposals", () => {
  const track = () => readFileMap(join(import.meta.dirname, "fixtures", "tracks", "shell-io"));
  const proposed = { proposed: "shell-io@1", note: "The learner decides in Codemm. End your turn." };

  // With no docker on PATH, anything that tried to build would fail differently.
  beforeEach(() => fakeDocker("missing"));

  it("stores a proposal and builds nothing; approving a roadmap builds nothing either", async () => {
    expect(await app.proposeTrack(track())).toEqual(proposed);
    await app.saveRoadmap(ws, "shell", roadmap());
    expect(app.listTracks()).toEqual([]);
    const [p] = app.listProposals();
    expect(p).toMatchObject({ track: "shell-io@1", digest: expect.stringMatching(/^[0-9a-f]{64}$/), files: track() });
  });

  it("replaces an older proposal for the same track", async () => {
    await app.proposeTrack(track());
    const first = app.listProposals()[0]!.digest;
    await app.proposeTrack({ ...track(), Dockerfile: `${track().Dockerfile}# again\n` });
    expect(app.listProposals().map((p) => p.digest)).not.toContain(first);
    expect(app.listProposals()).toHaveLength(1);
    await expect(app.installProposal("shell-io@1", first)).rejects.toThrow(/changed or is gone/);
  });

  it("refuses to install files that changed after the learner saw them", async () => {
    await app.proposeTrack(track());
    const { digest } = app.listProposals()[0]!;
    writeFileSync(join(process.env.CODEMM_HOME!, "proposals", "shell-io@1", digest, "files", "Dockerfile"), "FROM evil\n");
    await expect(app.installProposal("shell-io@1", digest)).rejects.toThrow(/changed or is gone/);
    await expect(app.installProposal("shell-io@1", "0".repeat(64))).rejects.toThrow(/changed or is gone/);
  });

  it("reports an identical installed track, and refuses a different one under the same version", async () => {
    const spec = parseTrackYaml(track()["track.yaml"]!);
    store.commitFolder(store.trackDir("shell-io@1"), track(), {
      "track.json": { format_version: 1, ...spec, image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
    });
    expect(await app.proposeTrack(track())).toEqual({ installed: "shell-io@1", unchanged: true });
    await expect(app.proposeTrack({ ...track(), Dockerfile: "FROM other\n" })).rejects.toThrow(/already installed/);
    expect(app.listProposals()).toEqual([]);
  });

  it("keeps a track file named like Codemm's own record intact", async () => {
    await app.proposeTrack({ ...track(), "proposal.json": "{}" });
    const [p] = app.listProposals();
    expect(p!.files["proposal.json"]).toBe("{}");
    await expect(app.installProposal("shell-io@1", p!.digest)).rejects.toThrow(/container runtime|Docker/i);
  });

  it.each([
    ["no Dockerfile", (t: Record<string, string>) => { delete t.Dockerfile; }],
    ["a probe without its fail solution", (t: Record<string, string>) => { delete t["probe/io/fail/main.sh"]; }],
  ])("refuses to propose a track with %s", async (_label, change) => {
    const t = track();
    change(t);
    await expect(app.proposeTrack(t)).rejects.toThrow(/Gate "valid"/);
    expect(app.listProposals()).toEqual([]);
  });

  it("refuses to install a proposal for a course whose style changed after it was proposed", async () => {
    await app.saveRoadmap(ws, "shell", roadmap());
    await app.proposeTrack(track());
    const { digest } = app.listProposals()[0]!;
    await app.saveRoadmap(ws, "shell", roadmap().replace("style: io", "style: unit"));
    await expect(app.installProposal("shell-io@1", digest)).rejects.toThrow(/Course "shell" needs style "unit", but shell-io@1 offers io/);
    await expect(app.saveTrack(track())).rejects.toThrow(/needs style "unit"/);
  });

  it("makes a roadmap save wait for an install of its track to finish", async () => {
    let saved = false;
    let save: Promise<unknown> | undefined;
    await store.withLock(store.trackLockPath("shell-io"), async () => {
      save = app.saveRoadmap(ws, "shell", roadmap()).then(() => (saved = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(saved).toBe(false);
    });
    await save;
    expect(saved).toBe(true);
  });

  it("drops a track's proposals", async () => {
    await app.proposeTrack(track());
    await app.dropProposal("shell-io@1");
    expect(app.listProposals()).toEqual([]);
  });
});
