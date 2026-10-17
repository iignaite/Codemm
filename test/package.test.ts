import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileMap } from "../src/files.js";
import { dockerUp } from "./docker/helpers.js";

const root = join(import.meta.dirname, "..");
let bin: string;
let files: string[];

/** Builds and packs Codemm exactly as it would ship, then installs the tarball into a clean folder. */
beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "codemm-pack-"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8" }))[0];
  files = packed.files.map((f: { path: string }) => f.path);
  const prefix = mkdtempSync(join(tmpdir(), "codemm-install-"));
  execFileSync("npm", ["install", "--prefix", prefix, "--prefer-offline", "--no-audit", "--no-fund", join(out, packed.filename)], { stdio: "ignore" });
  bin = join(prefix, "node_modules", ".bin", "codemm");
}, 300_000);

const run = (args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(bin, args, { encoding: "utf8", ...opts, env: { ...process.env, ...opts.env } });

describe("packed artifact", () => {
  it("ships only the CLI: no tracks, toolchains, tests or v1 code", () => {
    expect(files.every((f) => f.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(f))).toBe(true);
    expect(files).toContain("dist/cli.js");
  });

  it("reports its version", () => {
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    expect(run(["--version"]).stdout.trim()).toBe(version);
  });

  it("sets up a project, explains a missing course and runs the practice hook", () => {
    const ws = mkdtempSync(join(tmpdir(), "codemm-cli-"));
    const home = mkdtempSync(join(tmpdir(), "codemm-home-"));
    const env = { CODEMM_HOME: home };
    const init = run(["init"], { cwd: ws, env });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain(".mcp.json");

    const status = run(["status"], { cwd: ws, env });
    expect(status.status).toBe(1);
    expect(status.stderr).toMatch(/No course/);

    const hook = run(["hook", "claude", "--workspace", ws], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(ws, "exercises/x/y/main.c") } }) });
    expect(hook.status).toBe(2);
    expect(hook.stderr).toMatch(/practice mode/);
  });

  it.runIf(dockerUp)("runs a full author-and-learner round trip through all eight tools over real stdio", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codemm-mcp-"));
    const home = mkdtempSync(join(tmpdir(), "codemm-home-"));
    const client = new Client({ name: "codemm-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: bin, args: ["mcp", "--workspace", ws], env: { ...process.env, CODEMM_HOME: home } as Record<string, string> }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
      const text = (r.content as { text: string }[])[0]!.text;
      if (r.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text);
    };
    const fixtures = join(root, "test", "fixtures");
    try {
      // A label keeps this image distinct so other test files can't remove it.
      const track = readFileMap(join(fixtures, "tracks", "shell-io"));
      track.Dockerfile += "LABEL codemm.test=package\n";
      expect(await call("save_track", { files: track })).toEqual({ installed: "shell-io@1" });
      expect(await call("list_tracks")).toEqual([{ track: "shell-io@1", styles: ["io"], files: ["main.sh"] }]);
      await call("save_roadmap", { course: "shell", roadmap: readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8").replace("sh.loops", "sh.more").replace("Loops", "More") });
      expect(await call("next_step")).toMatchObject({ kind: "author", concept: "sh.basics" });
      const ex = readFileMap(join(fixtures, "exercises", "io-max"));
      ex["exercise.yaml"] = ex["exercise.yaml"]!.replace("sh.loops", "sh.basics");
      expect(await call("save_exercise", { files: ex })).toEqual({ exercise: "max-of-line" });
      expect(await call("get_exercise", { slug: "max-of-line" })).toMatchObject({ exercise: "max-of-line", files: ["main.sh"] });
      expect(await call("check")).toMatchObject({ passed: 0, total: 4, recorded: false });
      writeFileSync(join(ws, "exercises", "shell", "max-of-line", "main.sh"), "read line\necho 1\n");
      expect(await call("check")).toMatchObject({ passed: 0, total: 4, recorded: true });
      await expect(call("get_exercise", { slug: "nope" })).rejects.toThrow(/No exercise/);
      expect((await call("progress")).concepts[0]).toMatchObject({ id: "sh.basics", attempts: 1 });
    } finally {
      await client.close();
    }
  });

  it("serves all eight tools over real stdio", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codemm-mcp-"));
    const client = new Client({ name: "codemm-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: bin, args: ["mcp", "--workspace", ws], env: { ...process.env, CODEMM_HOME: mkdtempSync(join(tmpdir(), "codemm-home-")) } as Record<string, string> }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["check", "get_exercise", "list_tracks", "next_step", "progress", "save_exercise", "save_roadmap", "save_track"]);
      const list = await client.callTool({ name: "list_tracks", arguments: {} });
      expect(JSON.parse((list.content as { text: string }[])[0]!.text)).toEqual([]);
      const progress = await client.callTool({ name: "progress", arguments: {} });
      expect(progress.isError).toBe(true);
      expect((progress.content as { text: string }[])[0]!.text).toMatch(/No course/);
      const bad = await client.callTool({ name: "save_track", arguments: { files: { "../escape": "x" } } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
