/**
 * When the author journey produced no exercise, the tutor journey still needs one. This installs the repo's
 * POSIX-shell fixture track and exercise through the real Codemm MCP server, as an agent would.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readDirMap } from "./evidence.ts";
import { cleanEnv } from "./proc.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures");
export const SEED = { course: "bench-seed", slug: "max-of-line" };

export async function seedExercise(cli: string, ws: string, home: string): Promise<void> {
  const client = new Client({ name: "codemm-bench-seed", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--workspace", ws], env: cleanEnv({ CODEMM_HOME: home }) }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
      if (r.isError) throw new Error(`seed ${name} failed: ${r.content?.[0]?.text ?? ""}`);
    };
    await call("save_track", { files: readDirMap(join(FIXTURES, "tracks", "shell-io")) });
    await call("save_roadmap", { course: SEED.course, roadmap: readFileSync(join(FIXTURES, "roadmaps", "shell-io.yaml"), "utf8") });
    await call("save_exercise", { files: readDirMap(join(FIXTURES, "exercises", "io-max")) });
    await call("get_exercise", { slug: SEED.slug });
  } finally {
    await client.close();
  }
}
