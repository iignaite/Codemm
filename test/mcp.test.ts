import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { parseTrackYaml } from "../src/schemas.js";
import { createServer, parseToolList, type ServerOptions, TOOL_NAMES } from "../src/mcp.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

/** The per-job server: `codemm mcp --tools`, `--course` and `--desktop`. */

let ws: string;
let client: Client | undefined;
beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", tempDir("codemm-home-"));
  ws = tempDir("codemm-ws-");
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.unstubAllEnvs();
});

async function connect(options: ServerOptions = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(ws, "test", options).connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { client, call };
}

const roadmap = (goal: string) => `goal: ${goal}\ntrack: shell-io@1\nstyle: io\nconcepts:\n  - { id: sh.basics, title: Basics, requires: [] }\n`;

describe("--tools", () => {
  it("lists and accepts only the job's tools", async () => {
    const { client, call } = await connect({ tools: ["list_tracks", "get_roadmap"] });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_roadmap", "list_tracks"]);
    expect(await call("list_tracks")).toEqual([]);
    await expect(call("save_track", { files: {} })).rejects.toThrow(/save_track/);
  });

  it("serves every tool without the option", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("parses a comma-separated list and rejects unknown names", () => {
    expect(parseToolList("next_step, save_exercise")).toEqual(["next_step", "save_exercise"]);
    expect(() => parseToolList("next_step,rm_rf")).toThrow(/Unknown tool "rm_rf"/);
    expect(() => parseToolList(",")).toThrow(/at least one tool/);
  });
});

describe("--course", () => {
  it("scopes course tools to the job's course, even after the learner switches", async () => {
    await app.saveRoadmap(ws, "first", roadmap("First"));
    const { call } = await connect({ course: "first" });
    await app.saveRoadmap(ws, "second", roadmap("Second"));

    expect(await call("get_roadmap")).toMatchObject({ course: "first", goal: "First" });
    expect(await call("next_step")).toEqual({ kind: "setup", track: "shell-io@1" });
    await call("save_lesson", { id: "intro", concept: "sh.basics", title: "Intro", markdown: "Hello." });
    expect(app.listLessons(ws, "first").map((l) => l.id)).toEqual(["intro"]);
    expect(app.listLessons(ws)).toEqual([]);
    await call("mark_lesson_read", { id: "intro" });
    expect(app.listLessons(ws, "first")[0]!.read).toBe(true);
    await expect(call("save_roadmap", { course: "second", roadmap: roadmap("Changed") })).rejects.toThrow(/only course "first"/);
  });

  it("authors into the job's course while the learner has another course selected", async () => {
    // The job's course has an installed track; the selected one is a draft whose track isn't installed.
    const { id, version } = store.parseTrackRef("shell-io@1");
    store.writeTrackRecord("shell-io@1", {
      format_version: 1, id, version, styles: ["io"], files: ["main.sh"], run: "sh main.sh",
      limits: { time_ms: 2000, memory_mb: 256 }, image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString(),
    });
    await app.saveRoadmap(ws, "first", roadmap("First"));
    await app.saveRoadmap(ws, "second", roadmap("Second").replace("shell-io@1", "other@1"));
    fakeDocker("missing");
    const { call } = await connect({ course: "first" });
    const files = readFileMap(join(import.meta.dirname, "fixtures", "exercises", "io-max"));
    // Bound to "first", the save reaches the sandbox; unbound, it would stop at "other@1 is not installed".
    await expect(call("save_exercise", { files })).rejects.toThrow(/container runtime/i);
  });

  it("rejects an invalid course id", () => {
    expect(() => createServer(ws, "test", { course: "../x" })).toThrow(/Invalid course/);
  });
});

describe("--progress", () => {
  it.runIf(posix)("writes which gate save_exercise runs to the job's progress file, by name only", async () => {
    const fixtures = join(import.meta.dirname, "fixtures");
    const track = readFileMap(join(fixtures, "tracks", "shell-io"));
    store.commitFolder(store.trackDir("shell-io@1"), track, {
      "track.json": { format_version: 1, ...parseTrackYaml(track["track.yaml"]!), image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
    });
    await app.saveRoadmap(ws, "shell", readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8"));
    const progress = join(tempDir("codemm-progress-"), "job.json");
    const { call } = await connect({ course: "shell", progress });
    fakeDocker("streams");
    // Every fake run prints the same output, so the starter passes too and its gate fails.
    await expect(call("save_exercise", { files: readFileMap(join(fixtures, "exercises", "io-max")) })).rejects.toThrow(/starter unsolved/);
    expect(JSON.parse(readFileSync(progress, "utf8"))).toEqual({ format_version: 1, gate: "starter" });
  });

  it("must be an absolute path", () => {
    expect(() => createServer(ws, "test", { progress: "job.json" })).toThrow(/absolute/);
  });
});

describe("--desktop", () => {
  it("makes save_track propose instead of install", async () => {
    fakeDocker("missing");
    const { call } = await connect({ desktop: true });
    const track = readFileMap(join(import.meta.dirname, "fixtures", "tracks", "shell-io"));
    expect(await call("save_track", { files: track })).toEqual({ proposed: "shell-io@1", note: "The learner decides in Codemm. End your turn." });
    expect(app.listTracks()).toEqual([]);
    expect(app.listProposals()).toHaveLength(1);
  });
});

describe("--desktop with --course", () => {
  const tracks = join(import.meta.dirname, "fixtures", "tracks");
  // shell-unit's files under the course's track id: the right id@version, but only the unit style.
  const unitOnly = () => {
    const t = readFileMap(join(tracks, "shell-unit"));
    return { ...t, "track.yaml": t["track.yaml"]!.replace("id: shell-unit", "id: shell-io") };
  };

  it("refuses a proposal for the course's track that lacks the course's style, as a save the agent can fix", async () => {
    fakeDocker("missing");
    await app.saveRoadmap(ws, "first", roadmap("First"));
    const { call } = await connect({ course: "first", desktop: true });
    await expect(call("save_track", { files: unitOnly() })).rejects.toThrow(/Course "first" needs style "io".*offers unit/);
    expect(app.listProposals()).toEqual([]);
    expect(await call("save_track", { files: readFileMap(join(tracks, "shell-io")) })).toMatchObject({ proposed: "shell-io@1" });
  });
});

describe("lesson tools", () => {
  it("saves, reads and acknowledges a lesson; reading records nothing", async () => {
    await app.saveRoadmap(ws, "first", roadmap("First"));
    const { call } = await connect();
    expect(await call("save_lesson", { id: "intro", concept: "sh.basics", title: "Intro", markdown: "Hello." })).toEqual({ lesson: "intro" });
    expect(await call("get_lesson", { id: "intro" })).toEqual({ id: "intro", concept: "sh.basics", title: "Intro", markdown: "Hello.", notes: "", examples: [] });
    expect(app.listLessons(ws)[0]!.read).toBe(false);
    await call("mark_lesson_read", { id: "intro" });
    expect(app.listLessons(ws)[0]!.read).toBe(true);
  });
});
