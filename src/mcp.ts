import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as app from "./app.js";
import { CodemmError, infraError } from "./errors.js";
import { assertId, type FileMap, validateFileMap } from "./files.js";
import { containerCli } from "./sandbox.js";
import { wasmtimePath } from "./wasi.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * A failure's tool output. Its first line is always Codemm's own, `codemm:<code, kind or "error">`, so no text the
 * message quotes (a build log, a runner, the agent's own files) can stand there: callers (the desktop) act on it,
 * never on the wording.
 */
const failed = (e: CodemmError): Result => ({ isError: true, content: [{ type: "text", text: `codemm:${e.code ?? e.kind ?? "error"}\n${e.message}` }] });

/** Runs a use case and turns its result, or any error, into tool output the agent may see. */
async function respond(work: () => unknown): Promise<Result> {
  try {
    const value = await work();
    return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
  } catch (e) {
    if (e instanceof CodemmError) return failed(e);
    // A write that ran out of space here is this computer's problem, not the agent's.
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") return failed(infraError("This computer ran out of disk space, so nothing was saved. Free some space, then retry.", "host-disk"));
    // Unexpected errors may carry internal data (paths, record contents); never pass their text to the agent.
    if (process.env.CODEMM_DEBUG === "1") process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    return failed(new CodemmError("Codemm hit an unexpected error. Run `codemm doctor`; set CODEMM_DEBUG=1 for details."));
  }
}

// Values are checked in the handler, not by the schema: the SDK's own validation error names the offending key, which
// can be a hidden test or a mutant. validateFileMap reports it through describePath instead.
const files = z.record(z.string(), z.unknown()).describe('File map: { "relative/path": "file contents as text" }');
/** A file map from the agent, checked with Codemm's own (redacted) diagnostics. */
const fileMap = (f: Record<string, unknown>): FileMap => {
  validateFileMap(f as FileMap);
  return f as FileMap;
};
const slug = z.string().optional().describe("Exercise id. Defaults to the current exercise.");
const lessonId = z.string().describe("Lesson id");

export const TOOL_NAMES = [
  "list_tracks", "save_track", "save_roadmap", "get_roadmap", "next_step", "save_exercise", "get_exercise", "check", "progress",
  "save_lesson", "get_lesson", "mark_lesson_read",
] as const;

/** `--tools a,b`: the only tools this server registers. */
export function parseToolList(text: string): string[] {
  const names = text.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (names.length === 0) throw new CodemmError("--tools needs at least one tool name.");
  for (const name of names) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new CodemmError(`Unknown tool "${name}". Use: ${TOOL_NAMES.join(", ")}.`);
  }
  return names;
}

/** The engines this computer has (DESIGN §4.5): a container CLI, installed whether or not it runs, and wasmtime (looked for only without one). */
export type Engines = { docker: boolean; wasi: boolean };

/** Asks each binary only for its version, never a daemon, so whatever state Docker is in it costs a moment. wasmtime only matters without Docker. */
export function findEngines(): Engines {
  try {
    containerCli();
    return { docker: true, wasi: false };
  } catch {
    return { docker: false, wasi: wasmtimePath() !== undefined };
  }
}

/** Only servers whose agent chooses or writes a track need to know the engines. */
export const needsEngines = (tools: string[] | undefined): boolean => !tools || tools.includes("save_track") || tools.includes("save_roadmap");

/** The server instructions about this computer (DESIGN §4.5), or none when a container CLI is installed. */
function engineInstructions(engines: Engines | undefined): string | undefined {
  if (!engines || engines.docker) return undefined;
  return engines.wasi
    ? "This computer has no container runtime (Docker or Podman) installed, so write WASI tracks: io style, in an interpreted language that has a WASI build."
    : "This computer has no container runtime (Docker or Podman) installed and no wasmtime, so no track can run here until one is installed: tell the learner.";
}

/**
 * One server per agent job (docs/desktop/DESIGN.md §4.6): `course` replaces the workspace's active course,
 * `tools` limits the registered tools, and `desktop` makes save_track only propose (the learner consents in the app).
 * `progress` is a file where save_exercise writes which gate runs, by name only, for the app to show (§4.11).
 * `engines` is what this computer has; the server instructions say so when no container runtime is installed.
 */
export type ServerOptions = { course?: string; tools?: string[]; desktop?: boolean; progress?: string; engines?: Engines };

export function createServer(ws: string, version: string, { course, tools, desktop, progress, engines }: ServerOptions = {}): McpServer {
  if (course !== undefined) assertId("course", course);
  if (progress !== undefined && !isAbsolute(progress)) throw new CodemmError("--progress needs an absolute path.");
  const instructions = engineInstructions(engines);
  const server = new McpServer({ name: "codemm", version }, instructions ? { instructions } : undefined);
  const want = (name: (typeof TOOL_NAMES)[number]) => !tools || tools.includes(name);

  if (want("list_tracks")) server.registerTool("list_tracks", { description: "List installed tracks (language or framework environments) with their versions and test styles." }, () =>
    respond(() => app.listTracks()),
  );

  if (want("save_track")) server.registerTool(
    "save_track",
    desktop
      ? {
          description:
            "Propose a track: track.yaml, a Dockerfile (a WASI track has none) and probe/ files. Codemm checks the files and asks the learner before building anything. " +
            "It returns the proposed id@version; then end your turn.",
          inputSchema: { files },
        }
      : {
          description:
            "Install a track: track.yaml, a Dockerfile (a WASI track has none) and probe/ files. Building the image runs the Dockerfile WITH network access " +
            "(a WASI track downloads its toolchain instead), so only install tracks the learner agrees to. " +
            "Codemm then runs the probes with the network off and installs the track only if every gate passes; otherwise it returns what failed.",
          inputSchema: { files },
        },
    ({ files: f }) => respond(() => (desktop ? app.proposeTrack(fileMap(f)) : app.saveTrack(fileMap(f)))),
  );

  if (want("save_roadmap")) server.registerTool(
    "save_roadmap",
    {
      description:
        "Create or update the course roadmap and make it active in this workspace. YAML with title (the course's name in a few plain words, " +
        "at most 60 characters), goal, track (id@version, installed or not yet), style (io|unit), concepts [{id, title, requires, practice?, pitfalls?, refs?}] and optional sources " +
        "[{title, url}]; refs are indexes into sources. Keep concept ids stable when you edit it.",
      inputSchema: { course: z.string().describe("Course id, e.g. c-pointers"), roadmap: z.string().describe("Roadmap YAML") },
    },
    ({ course: c, roadmap }) => respond(() => app.saveRoadmap(ws, c, roadmap, course)),
  );

  if (want("get_roadmap")) server.registerTool(
    "get_roadmap",
    { description: "The course roadmap: title, goal, track, style and concepts with their prerequisites, and the track's contract once it's set up." },
    () => respond(() => app.getRoadmap(ws, course, true)),
  );

  if (want("next_step")) server.registerTool(
    "next_step",
    {
      description:
        "What to do next: setup (install the track), practice an existing exercise, review a mastered concept on an exercise (a check keeps it mastered), " +
        "author a new one (concept, difficulty, style, track; review: true when it's for a review), stuck, or done. " +
        "On practice and author, lesson is null when the concept needs a lesson first, or the id of a lesson the learner hasn't read yet; teach before the activity until it's gone.",
    },
    () => respond(() => app.nextStep(ws, course)),
  );

  if (want("save_exercise")) server.registerTool(
    "save_exercise",
    {
      description:
        "Author tool. Save an exercise (exercise.yaml, README.md, starter/, solution/, mutants/<name>/, tests/visible/, tests/hidden/). " +
        "Codemm runs every gate and stores it only if all pass. Returns only the exercise id; report nothing else to the tutor.",
      inputSchema: { files },
    },
    ({ files: f }) => respond(() => app.saveExercise(ws, fileMap(f), course, progress ? app.gateProgressTo(progress) : undefined)),
  );

  if (want("get_exercise")) server.registerTool("get_exercise", { description: "Show an exercise to the learner: statement, the file(s) to edit, visible tests and hint.", inputSchema: { slug } }, ({ slug: s }) =>
    respond(() => app.getExercise(ws, s, course)),
  );

  if (want("check")) server.registerTool(
    "check",
    { description: "Grade the learner's current code against all tests and record the attempt. Hidden tests report only pass or fail.", inputSchema: { slug } },
    ({ slug: s }) => respond(() => app.checkExercise(ws, s, course)),
  );

  if (want("progress")) server.registerTool("progress", { description: "Mastery and difficulty per concept, and the next step." }, () => respond(() => app.progress(ws, course)));

  if (want("save_lesson")) server.registerTool(
    "save_lesson",
    {
      description:
        "Save a lesson for one roadmap concept: Markdown (at most 64 KB) the learner reads before the activity, and up to 5 runnable examples. " +
        "Each example is a file map with exactly the track's learner files (for unit, plus tests/ files); Codemm runs each in the sandbox with no input and it must exit 0. " +
        "Place example N in the Markdown as a fenced block with info string example whose only line is N. An example that needs input goes in a plain code block. " +
        "Diagrams and charts go in fenced blocks with info string mermaid (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, pie, xychart), only when a picture teaches better than words; give each an accTitle and accDescr for screen readers. " +
        "The id must be new in the course.",
      inputSchema: {
        id: lessonId, concept: z.string().describe("Concept id from the roadmap"), title: z.string(), markdown: z.string(),
        examples: z.array(files).optional().describe("Runnable examples; they need the track set up"),
      },
    },
    (lesson) => respond(() => app.saveLesson(ws, lesson, course)),
  );

  if (want("get_lesson")) server.registerTool("get_lesson", { description: "Read a lesson and the learner's notes on it. Records nothing.", inputSchema: { id: lessonId } }, ({ id }) =>
    respond(() => app.getLesson(ws, id, course)),
  );

  if (want("mark_lesson_read")) server.registerTool(
    "mark_lesson_read",
    { description: "Record that the learner has read a lesson. Call it only after the learner says they've read it.", inputSchema: { id: lessonId } },
    ({ id }) => respond(() => app.markLessonRead(ws, id, course)),
  );

  return server;
}

export async function serveMcp(ws: string, version: string, options: ServerOptions = {}): Promise<void> {
  const engines = needsEngines(options.tools) ? findEngines() : undefined;
  await createServer(ws, version, { engines, ...options }).connect(new StdioServerTransport());
}
