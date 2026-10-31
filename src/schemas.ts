import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CodemmError } from "./errors.js";
import { assertRelativePath, ID_PATTERN } from "./files.js";

const MAX_YAML_BYTES = 65_536;
const Id = z.string().regex(ID_PATTERN, "must be 1-64 lowercase letters, digits, '.', '_' or '-'");
const Style = z.enum(["io", "unit"]);
export type Style = z.infer<typeof Style>;

/** time_ms is per io case, or for a unit track's whole test command (DESIGN §4.3). */
export const LIMITS = { time_ms: { min: 100, max: 120_000, default: 2000 }, memory_mb: { min: 64, max: 2048, default: 256 } };
const clamp = (n: number | undefined, l: { min: number; max: number; default: number }) => Math.min(l.max, Math.max(l.min, n ?? l.default));

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function parseWith<T>(schema: z.ZodType<T>, yaml: string, what: string): T {
  if (Buffer.byteLength(yaml) > MAX_YAML_BYTES) throw new CodemmError(`${what} is larger than 64 KB.`);
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (e) {
    throw new CodemmError(`${what} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CodemmError(`Invalid ${what}: ${describe(parsed.error)}`);
  return parsed.data;
}

/** A path in a WASI toolchain's archive (§3's file-map rules), with no ":" since wasmtime's --dir splits on "::". */
const ArchivePath = z.string().max(512).superRefine((p, ctx) => {
  try {
    assertRelativePath(p);
    if (p.includes(":")) throw new Error();
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a relative path in the archive, with \"/\" separators, no \".\" or \"..\" parts and no \":\"" });
  }
});

/** A folder's path inside the sandbox: absolute, with no "." or ".." part, and not /work or under it, where the learner's files are. */
const sandboxDir = (p: string) =>
  /^(\/[A-Za-z0-9._-]+)+$/.test(p) && p.split("/").every((part) => part !== "." && part !== "..") && p !== "/work" && !p.startsWith("/work/");
const MAX_ENV_VALUE = 1024;

/** A WASI build of the language's interpreter, as a Docker track names a base image (DESIGN §4.5). */
const WasiYaml = z
  .object({
    url: z.string().max(2000).refine((u) => {
      try {
        const url = new URL(u);
        return url.protocol === "https:" && url.username === "" && url.password === "" && /\.(wasm|zip|tar\.gz)$/.test(url.pathname);
      } catch {
        return false;
      }
    }, "must be an https link with no credentials, whose path ends in .wasm, .zip or .tar.gz"),
    /** Optional: without it, Codemm records the digest it downloads and installs with a warning (DESIGN §4.5). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be the downloaded file's SHA-256, as 64 lowercase hex digits").optional(),
    module: ArchivePath,
    dirs: z
      .record(z.string().refine(sandboxDir, "dirs keys must be absolute folders in the sandbox, other than /, /work and folders under /work"), ArchivePath)
      .refine((d) => Object.keys(d).length <= 16, "dirs lists at most 16 folders")
      .refine((d) => !Object.keys(d).some((a) => Object.keys(d).some((b) => a.startsWith(`${b}/`))), "a dirs key can't be under another")
      .default({}),
    env: z
      .record(
        z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env names are uppercase letters, digits and _"),
        z.string().refine((v) => Buffer.byteLength(v) <= MAX_ENV_VALUE && !v.includes("\0"), "env values are at most 1 KB"),
      )
      .refine((e) => Object.keys(e).length <= 32, "env holds at most 32 names")
      .default({}),
  })
  .strict();
export type WasiSpec = z.infer<typeof WasiYaml>;

/** A command; an empty one (\`test:\` with no value, which YAML reads as null) counts as left out. */
const Command = z.preprocess((v) => v ?? undefined, z.string().min(1).max(2000).optional());

const TrackYaml = z
  .object({
    id: Id,
    version: z.number().int().positive("version must be a positive integer").max(999_999_999, "version must have at most 9 digits"),
    styles: z.array(Style).min(1),
    files: z.array(z.string()).min(1).max(20),
    build: Command,
    run: Command,
    test: Command,
    limits: z.object({ time_ms: z.number().int().positive().optional(), memory_mb: z.number().int().positive().optional() }).strict().optional(),
    wasi: WasiYaml.optional(),
  })
  .strict();

export type TrackSpec = Omit<z.infer<typeof TrackYaml>, "limits"> & { limits: { time_ms: number; memory_mb: number } };

/** Learner files share a folder with the statement and visible tests, so these names are taken. */
const isReserved = (f: string) => ["readme.md", "tests"].some((r) => f.toLowerCase() === r || f.toLowerCase().startsWith(`${r}/`));

export function parseTrackYaml(yaml: string): TrackSpec {
  const t = parseWith(TrackYaml, yaml, "track.yaml");
  for (const f of t.files) {
    assertRelativePath(f);
    if (isReserved(f)) throw new CodemmError(`Invalid track.yaml: "${f}" is reserved for the statement and visible tests. Rename the learner file.`);
  }
  if (new Set(t.files).size !== t.files.length) throw new CodemmError("Invalid track.yaml: files lists the same file twice.");
  const lower = t.files.map((f) => f.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new CodemmError("Invalid track.yaml: two learner files differ only by case.");
  const clash = t.files.find((f) => lower.some((g) => g.startsWith(`${f.toLowerCase()}/`)));
  if (clash) throw new CodemmError(`Invalid track.yaml: "${clash}" can't be both a file and a folder.`);
  if (t.styles.includes("io") && !t.run) throw new CodemmError("Invalid track.yaml: an io track needs a run command.");
  if (t.styles.includes("unit") && !t.test) throw new CodemmError("Invalid track.yaml: a unit track needs a test command.");
  if (t.wasi) {
    // The WASI engine runs io programs of interpreted languages only (DESIGN §4.5).
    if (t.styles.length !== 1 || t.styles[0] !== "io") throw new CodemmError("Invalid track.yaml: a WASI track's styles must be [io].");
    if (t.build || t.test) throw new CodemmError(`Invalid track.yaml: a WASI track has no ${t.build ? "build" : "test"} command. It runs an interpreter's WASI build, so remove it.`);
    const path = new URL(t.wasi.url).pathname;
    if (path.endsWith(".wasm")) {
      let name = "";
      try {
        name = decodeURIComponent(path.split("/").at(-1)!);
      } catch {
        // Not a name: refused below.
      }
      if (!name || name.includes("/") || t.wasi.module !== name) {
        throw new CodemmError(`Invalid track.yaml: when wasi.url is a .wasm, wasi.module must be the downloaded file's name${name && !name.includes("/") ? `, "${name}"` : ", and the url must end in a plain file name"}.`);
      }
    }
  }
  return { ...t, limits: { time_ms: clamp(t.limits?.time_ms, LIMITS.time_ms), memory_mb: clamp(t.limits?.memory_mb, LIMITS.memory_mb) } };
}

/** An https link with no credentials: the only kind the app opens, in the learner's browser. */
const httpsUrl = z.string().max(2000).refine((u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "must be an https link");

/** The roadmaps and docs the agent used while planning (optional). */
const Source = z.object({ title: z.string().min(1).max(120), url: httpsUrl }).strict();

const RoadmapYaml = z
  .object({
    /** The course's name as the learner would say it (optional: a course without one is named by its goal). */
    title: z.string().trim().min(1).max(60).optional(),
    goal: z.string().min(1).max(500),
    track: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}@[1-9][0-9]{0,8}$/, "track must be pinned as id@version"),
    style: Style,
    concepts: z
      .array(z.object({
        id: Id, title: z.string().min(1).max(200), requires: z.array(Id).max(20).default([]),
        practice: z.string().trim().min(1).max(300).optional(),
        pitfalls: z.array(z.string().min(1).max(200)).max(5).optional(),
        refs: z.array(z.number().int().min(0)).max(10).refine((refs) => new Set(refs).size === refs.length, "refs must not repeat").optional(),
      }).strict())
      .min(1, "add at least one concept")
      .max(200),
    sources: z.array(Source).max(10, "list at most 10 sources").optional(),
  })
  .strict();
export type Roadmap = z.infer<typeof RoadmapYaml>;

/** Structural roadmap rules: unique ids, known prerequisites, no cycles (Kahn's algorithm). */
export function parseRoadmapYaml(yaml: string): Roadmap {
  const r = parseWith(RoadmapYaml, yaml, "roadmap");
  const ids = new Set<string>();
  for (const c of r.concepts) {
    if (ids.has(c.id)) throw new CodemmError(`Invalid roadmap: duplicate concept id "${c.id}".`);
    ids.add(c.id);
  }
  for (const c of r.concepts) {
    if (c.refs?.some((ref) => ref >= (r.sources?.length ?? 0))) throw new CodemmError(`Invalid roadmap: "${c.id}" has a ref out of range.`);
    if (r.sources?.length && (c.practice !== undefined || c.pitfalls !== undefined) && !c.refs?.length) {
      throw new CodemmError(`Invalid roadmap: "${c.id}" needs at least one ref for its practice or pitfalls.`);
    }
    if (new Set(c.requires).size !== c.requires.length) throw new CodemmError(`Invalid roadmap: "${c.id}" lists a prerequisite more than once.`);
    for (const req of c.requires) if (!ids.has(req)) throw new CodemmError(`Invalid roadmap: "${c.id}" requires unknown concept "${req}".`);
  }
  const indegree = new Map(r.concepts.map((c) => [c.id, c.requires.length]));
  const queue = r.concepts.filter((c) => c.requires.length === 0).map((c) => c.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen += 1;
    for (const c of r.concepts) {
      if (!c.requires.includes(id)) continue;
      const left = indegree.get(c.id)! - 1;
      indegree.set(c.id, left);
      if (left === 0) queue.push(c.id);
    }
  }
  if (seen !== r.concepts.length) {
    const cyclic = [...indegree].filter(([, n]) => n > 0).map(([id]) => id);
    throw new CodemmError(`Invalid roadmap: prerequisites form a cycle among ${cyclic.join(", ")}.`);
  }
  return r;
}

const ExerciseYaml = z
  .object({
    slug: Id,
    style: Style.optional(),
    concepts: z.array(Id).min(1).max(10).refine((c) => new Set(c).size === c.length, "concepts must not repeat"),
    difficulty: z.number().int().min(1).max(3),
    hint: z.string().max(2000).optional(),
  })
  .strict();
export type ExerciseSpec = z.infer<typeof ExerciseYaml>;

export const parseExerciseYaml = (yaml: string): ExerciseSpec => parseWith(ExerciseYaml, yaml, "exercise.yaml");

// Records Codemm itself writes. Each carries format_version so a future release can migrate forward.

const TrackBase = z.object({
  format_version: z.literal(1),
  id: Id,
  version: z.number().int().positive(),
  styles: z.array(Style),
  files: z.array(z.string()),
  build: z.string().optional(),
  run: z.string().optional(),
  test: z.string().optional(),
  limits: z.object({ time_ms: z.number(), memory_mb: z.number() }),
  installedAt: z.string(),
});
/** Where a WASI track's toolchain is ($CODEMM_HOME/toolchains/<sha256>/) and how it runs; the url stays in track.yaml. */
// Its paths are held to track.yaml's rules again, so a track.json changed outside Codemm can't map another folder.
export const WasiRecord = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/), module: ArchivePath, dirs: z.record(z.string().refine(sandboxDir), ArchivePath), env: z.record(z.string(), z.string()),
});
export type WasiRecord = z.infer<typeof WasiRecord>;
/** Exactly one engine: a Docker track's image (and the ID checks run by), or a WASI track's toolchain (DESIGN §4.5). */
export const TrackRecord = z.union([
  TrackBase.extend({ image: z.string(), imageId: z.string(), wasi: z.undefined().optional() }),
  TrackBase.extend({ wasi: WasiRecord, image: z.undefined().optional(), imageId: z.undefined().optional() }),
]);
export type TrackRecord = z.infer<typeof TrackRecord>;

export const CourseRecord = RoadmapYaml.extend({ format_version: z.literal(1), course: Id });
export type CourseRecord = z.infer<typeof CourseRecord>;

export const ExerciseRecord = z.object({
  format_version: z.literal(1),
  slug: Id,
  style: Style,
  concepts: z.array(Id),
  difficulty: z.number().int(),
  hint: z.string().optional(),
  track: z.string(),
  createdAt: z.string(),
  /** io: expected stdout per case name, written from the reference; a long one as its digest, size and start. */
  expected: z.record(z.string(), z.union([z.string(), z.object({ sha256: z.string(), bytes: z.number().int().nonnegative(), head: z.string() })])).optional(),
  /** unit: test names per set, recorded from the reference. */
  inventory: z.object({ visible: z.array(z.string()), hidden: z.array(z.string()) }).optional(),
});
export type ExerciseRecord = z.infer<typeof ExerciseRecord>;

export const WorkspaceConfig = z.object({
  format_version: z.literal(1),
  course: Id.optional(),
  current: Id.optional(),
  assist: z.boolean().default(false),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const LearnerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    format_version: z.literal(1),
    kind: z.literal("check"),
    at: z.string(),
    exercise: Id,
    concepts: z.array(Id),
    difficulty: z.number().int(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    assisted: z.boolean(),
  }),
  z.object({ format_version: z.literal(1), kind: z.literal("skip"), at: z.string(), concept: Id }),
  z.object({ format_version: z.literal(1), kind: z.literal("assist"), at: z.string(), exercise: Id }),
  z.object({ format_version: z.literal(1), kind: z.literal("retry"), at: z.string(), concept: Id }),
  z.object({ format_version: z.literal(1), kind: z.literal("read"), at: z.string(), lesson: Id, concept: Id }),
]);
export type LearnerEventRecord = z.infer<typeof LearnerEventSchema>;

const MAX_LESSON_BYTES = 65_536;
const mapBytes = (m: Record<string, string>) => Object.values(m).reduce((n, t) => n + Buffer.byteLength(t), 0);
const LessonInput = z
  .object({
    id: Id,
    concept: Id,
    title: z.string().min(1).max(200),
    markdown: z.string().min(1),
    /** Runnable examples: file maps that follow the installed track's contract (checked by save_lesson). */
    examples: z
      .array(z.record(z.string(), z.string()).refine((m) => mapBytes(m) <= MAX_LESSON_BYTES, "an example is larger than 64 KB"))
      .max(5, "add at most 5 examples")
      .refine((all) => all.reduce((n, m) => n + Object.keys(m).length, 0) <= 250, "examples hold at most 250 files in all")
      .optional(),
  })
  .strict()
  .refine((l) => Buffer.byteLength(l.markdown) <= MAX_LESSON_BYTES, { message: "markdown is larger than 64 KB", path: ["markdown"] });
export type LessonInput = z.infer<typeof LessonInput>;

/** CommonMark, as the app renders lessons (raw HTML off), so core and the app see the same blocks. */
const markdown = new MarkdownIt({ html: false, linkify: false });

/**
 * Where the Markdown places example N: a top-level, unindented fence (``` or ~~~) whose info string is `example`,
 * holding one line with N, closed by the next line. The app's renderer (desktop ui/Markdown.tsx) applies the same
 * test to the same markdown-it tokens.
 */
export function exampleRefs(text: string): number[] {
  const lines = text.split(/\r\n?|\n/);
  return markdown.parse(text, {}).flatMap((t) => {
    const block = t.map !== null && t.map[1] - t.map[0] === 3 && /^[`~]/.test(lines[t.map[0]] ?? "");
    return t.type === "fence" && t.level === 0 && block && t.info.trim() === "example" && /^[ \t]*\d+[ \t]*\n$/.test(t.content) ? [Number(t.content.trim())] : [];
  });
}

/** A lesson as the agent saves it: static Markdown for one roadmap concept, and optional runnable examples. */
export function parseLesson(input: unknown): LessonInput {
  const parsed = LessonInput.safeParse(input);
  if (!parsed.success) throw new CodemmError(`Invalid lesson: ${describe(parsed.error)}`);
  const count = parsed.data.examples?.length ?? 0;
  const refs = exampleRefs(parsed.data.markdown);
  const missing = refs.find((n) => n < 1 || n > count);
  if (missing !== undefined) throw new CodemmError(`Invalid lesson: the markdown places example ${missing}, but there are ${count} examples.`);
  for (let n = 1; n <= count; n++) {
    if (!refs.includes(n)) throw new CodemmError(`Invalid lesson: example ${n} is never placed. Put a block "\`\`\`example" with the line ${n} where it belongs.`);
  }
  return parsed.data;
}

/** The learner's notes on a lesson share the lesson's size limit. */
export function assertNotes(text: string): string {
  if (Buffer.byteLength(text) > MAX_LESSON_BYTES) throw new CodemmError("Notes are larger than 64 KB.");
  return text;
}

/** With examples: how many, and the track and style they were checked with, which they always run with. */
export const LessonRecord = z.object({
  format_version: z.literal(1), id: Id, concept: Id, title: z.string(), created: z.string(),
  examples: z.number().int().nonnegative().optional(), track: z.string().optional(), style: Style.optional(),
});
export type LessonRecord = z.infer<typeof LessonRecord>;

/** A track the agent proposed in the desktop app, waiting for the learner's consent. */
export const ProposalRecord = z.object({ format_version: z.literal(1), track: z.string(), digest: z.string(), created: z.string() });
export type ProposalRecord = z.infer<typeof ProposalRecord>;
