/**
 * Installs a fixed track, roadmap and exercise through the real Codemm MCP server, as an agent would, so a tutor
 * journey can run on a known exercise: the subject's fixture for `--journey tutor`, or the repo's POSIX-shell
 * fixture when the author journey produced no exercise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";
import { readDirMap } from "./evidence.ts";
import { cleanEnv } from "./proc.ts";

export type Fixture = { track: string; roadmap: string; exercise: string; course: string; slug: string };

const fixture = (track: string, roadmap: string, exercise: string, course: string): Fixture => ({
  track,
  roadmap,
  exercise,
  course,
  slug: String((parse(readFileSync(join(exercise, "exercise.yaml"), "utf8")) as { slug: unknown }).slug),
});

const TEST_FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");
const BENCH_FIXTURES = join(import.meta.dirname, "..", "fixtures");

export const shellFixture = () => fixture(join(TEST_FIXTURES, "tracks", "shell-io"), join(TEST_FIXTURES, "roadmaps", "shell-io.yaml"), join(TEST_FIXTURES, "exercises", "io-max"), "bench-seed");

/** bench/fixtures/<subject>/: an agent-written track and gated exercise kept from an earlier run (see its README). */
export const subjectFixture = (subject: string) => {
  const dir = join(BENCH_FIXTURES, subject);
  return fixture(join(dir, "track"), join(dir, "roadmap.yaml"), join(dir, "exercise"), `bench-${subject}`);
};

export async function seedExercise(cli: string, ws: string, home: string, containerCli: string, f: Fixture): Promise<void> {
  const client = new Client({ name: "codemm-bench-seed", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--workspace", ws], env: cleanEnv({ CODEMM_HOME: home, CODEMM_CONTAINER_CLI: containerCli }) }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
      if (r.isError) throw new Error(`seed ${name} failed: ${r.content?.[0]?.text ?? ""}`);
    };
    await call("save_track", { files: readDirMap(f.track) });
    await call("save_roadmap", { course: f.course, roadmap: readFileSync(f.roadmap, "utf8") });
    await call("save_exercise", { files: readDirMap(f.exercise) });
    await call("get_exercise", { slug: f.slug });
  } finally {
    await client.close();
  }
}
