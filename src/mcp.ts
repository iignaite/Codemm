import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as app from "./app.js";
import { CodemmError } from "./errors.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a use case and turns its result, or a Codemm error, into tool output. Other errors propagate. */
async function respond(work: () => unknown): Promise<Result> {
  try {
    const value = await work();
    return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
  } catch (e) {
    if (e instanceof CodemmError) return { isError: true, content: [{ type: "text", text: e.message }] };
    throw e;
  }
}

const files = z.record(z.string(), z.string()).describe('File map: { "relative/path": "file contents" }');
const slug = z.string().optional().describe("Exercise id. Defaults to the current exercise.");

export function createServer(ws: string, version: string): McpServer {
  const server = new McpServer({ name: "codemm", version });

  server.registerTool("list_tracks", { description: "List installed tracks (language or framework environments) with their versions and test styles." }, () =>
    respond(() => app.listTracks()),
  );

  server.registerTool(
    "save_track",
    {
      description:
        "Install a track: track.yaml, Dockerfile and probe/ files. Building the image runs the Dockerfile WITH network access, so only install tracks the learner agrees to. " +
        "Codemm then runs the probes with the network off and installs the track only if every gate passes; otherwise it returns what failed.",
      inputSchema: { files },
    },
    ({ files: f }) => respond(() => app.saveTrack(f)),
  );

  server.registerTool(
    "save_roadmap",
    {
      description: "Create or update the course roadmap and make it active in this workspace. YAML with goal, track (id@version), style (io|unit) and concepts [{id, title, requires}].",
      inputSchema: { course: z.string().describe("Course id, e.g. c-pointers"), roadmap: z.string().describe("Roadmap YAML") },
    },
    ({ course, roadmap }) => respond(() => app.saveRoadmap(ws, course, roadmap)),
  );

  server.registerTool("next_step", { description: "What to do next: practice an existing exercise, author a new one (concept, difficulty, style, track), stuck, or done." }, () =>
    respond(() => app.nextStep(ws)),
  );

  server.registerTool(
    "save_exercise",
    {
      description:
        "Author tool. Save an exercise (exercise.yaml, README.md, starter/, solution/, mutants/<name>/, tests/visible/, tests/hidden/). " +
        "Codemm runs every gate and stores it only if all pass. Returns only the exercise id; report nothing else to the tutor.",
      inputSchema: { files },
    },
    ({ files: f }) => respond(() => app.saveExercise(ws, f)),
  );

  server.registerTool("get_exercise", { description: "Show an exercise to the learner: statement, the file(s) to edit, visible tests and hint.", inputSchema: { slug } }, ({ slug: s }) =>
    respond(() => app.getExercise(ws, s)),
  );

  server.registerTool(
    "check",
    { description: "Grade the learner's current code against all tests and record the attempt. Hidden tests report only pass or fail.", inputSchema: { slug } },
    ({ slug: s }) => respond(() => app.checkExercise(ws, s)),
  );

  server.registerTool("progress", { description: "Mastery and difficulty per concept, and the next step." }, () => respond(() => app.progress(ws)));

  return server;
}

export async function serveMcp(ws: string, version: string): Promise<void> {
  await createServer(ws, version).connect(new StdioServerTransport());
}
