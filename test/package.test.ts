import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

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
