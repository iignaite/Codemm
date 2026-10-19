import {
  closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statfsSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { CodemmError, infraError } from "./errors.js";
import { assertId, assertRelativePath, type FileMap, readFileMap, validateFileMap, writeFileMap } from "./files.js";
import type { LearnerEvent } from "./learner.js";
import { CourseRecord, ExerciseRecord, LearnerEventSchema, LessonRecord, ProposalRecord, TrackRecord, WorkspaceConfig } from "./schemas.js";

/** Persistence for everything under $CODEMM_HOME and the workspace's codemm.json. */

export const codemmHome = () => process.env.CODEMM_HOME ?? join(homedir(), ".codemm");

/**
 * The image tag for a track, named after this Codemm home (8 hex characters of the SHA-256 of its real path), so two
 * homes on one Docker that install the same id@version never overwrite each other's tag.
 */
export function trackImageTag(id: string, version: number): string {
  mkdirSync(codemmHome(), { recursive: true });
  const home = createHash("sha256").update(realpathSync.native(codemmHome())).digest("hex").slice(0, 8);
  return `codemm-track-${home}-${id}:${version}`;
}
const tracksDir = () => join(codemmHome(), "tracks");
const courseDir = (course: string) => {
  assertId("course", course);
  return join(codemmHome(), "courses", course);
};

export function parseTrackRef(ref: string): { id: string; version: number } {
  const m = /^([a-z0-9][a-z0-9._-]{0,63})@([1-9][0-9]{0,8})$/.exec(ref);
  if (!m) throw new CodemmError(`Invalid track "${ref}". Use id@version, for example python@1.`);
  return { id: m[1]!, version: Number(m[2]) };
}
export const trackDir = (ref: string) => {
  parseTrackRef(ref);
  return join(tracksDir(), ref);
};
export const trackLockPath = (id: string) => {
  assertId("track id", id);
  return join(tracksDir(), `.${id}.lock`);
};
export const courseLockPath = (course: string) => join(courseDir(course), ".lock");

// ---------- locks ----------
//
// A lock file is created atomically *with* its content by hard-linking a private temp file, so no
// one ever sees an empty lock. A lock whose owner PID is gone is stale, but only the holder of the
// short-lived `.reclaim` mutex may delete it, and only after re-reading that it is still the same
// stale lock. Release deletes the lock only if it still carries our token.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readOwner = (path: string): { pid: number; token: string } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};
/** Whether process `pid` is running (EPERM: it is, as another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
function tryCreate(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}
function reclaimIfStale(path: string, seen: string): void {
  const mutex = `${path}.reclaim`;
  if (!tryCreate(mutex, JSON.stringify({ pid: process.pid }))) {
    // Held for microseconds. Only a mutex whose owner process is gone may be cleared, and only if unchanged.
    let held: string | undefined;
    try {
      held = readFileSync(mutex, "utf8");
    } catch {
      return;
    }
    const owner = (() => {
      try {
        return JSON.parse(held) as { pid: number };
      } catch {
        return undefined;
      }
    })();
    if (owner && !processAlive(owner.pid)) {
      try {
        if (readFileSync(mutex, "utf8") === held) unlinkSync(mutex);
      } catch {
        // gone already
      }
    }
    return;
  }
  try {
    let current: string | undefined;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (current === seen) unlinkSync(path);
  } finally {
    unlinkSync(mutex);
  }
}

/** Runs `work` while holding an exclusive cross-process lock. Waits up to `waitMs` for a live owner. */
export async function withLock<T>(path: string, work: () => Promise<T>, waitMs = 600_000): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const content = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
  const until = Date.now() + waitMs;
  while (!tryCreate(path, content)) {
    let seen: string | undefined;
    try {
      seen = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const owner = readOwner(path);
    if (!owner || !processAlive(owner.pid)) {
      reclaimIfStale(path, seen);
      continue;
    }
    if (Date.now() > until) throw new CodemmError("Codemm is busy with another change to this course or track. Retry in a moment.");
    await sleep(100);
  }
  try {
    return await work();
  } finally {
    if (readOwner(path)?.token === token) rmSync(path, { force: true });
  }
}

// ---------- records ----------

/** Parses one of Codemm's own records. A bad record is reported by file, never by echoing its contents. */
function parseRecord<T>(schema: { parse: (v: unknown) => T }, file: string): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new CodemmError(`Codemm's record ${file} is damaged. Restore it from a backup, or remove that track, course or exercise.`, "damaged");
  }
}

// ---------- atomic writes ----------

/**
 * Writes `text` to a new temp file beside `path` and returns its path. Never opens an existing file or a symlink.
 * `mode` is before the umask: 0o666 as writeFileSync makes Codemm's own files, 0o644 for learner files.
 */
function writeTempBeside(path: string, text: string, mode: number): string {
  const tmp = join(dirname(path), `.codemm-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Replaces `path` with `text` whole: a temp file, then a rename. */
export function writeTextAtomic(path: string, text: string, mode = 0o666): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = writeTempBeside(path, text, mode);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const writeJsonAtomic = (path: string, value: unknown) => writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

/** A job's progress file (`codemm mcp --progress`): the exercise gate running, by name only. Replaced whole each time. */
export function writeJobProgress(path: string, gate: string): void {
  writeJsonAtomic(path, { format_version: 1, gate });
}

/** Writes `files` (and optional JSON records) into a fresh folder, then renames it to `target`. */
export function commitFolder(target: string, files: FileMap, records: Record<string, unknown> = {}): void {
  if (existsSync(target)) throw new CodemmError(`${target} already exists.`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = mkdtempSync(join(dirname(target), ".staging-"));
  try {
    writeFileMap(tmp, files);
    for (const [name, value] of Object.entries(records)) writeFileSync(join(tmp, name), `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

// ---------- tracks ----------

export function readTrack(ref: string): TrackRecord | undefined {
  const file = join(trackDir(ref), "track.json");
  if (!existsSync(file)) return undefined;
  return parseRecord(TrackRecord, file);
}

/** The track's own files, without Codemm's track.json. */
export function readTrackFiles(ref: string): FileMap {
  return readFileMap(trackDir(ref), ["track.json"]);
}

export function writeTrackRecord(ref: string, record: TrackRecord): void {
  writeJsonAtomic(join(trackDir(ref), "track.json"), record);
}

export function listTracks(): TrackRecord[] {
  if (!existsSync(tracksDir())) return [];
  return readdirSync(tracksDir())
    .filter((n) => n.includes("@") && !n.startsWith("."))
    .sort()
    .flatMap((ref) => readTrack(ref) ?? []);
}

// ---------- proposals ----------
//
// A track the agent proposed in the desktop app, kept until the learner consents. Each proposal is an
// immutable folder named by the digest of its files, so consent binds exactly the files the learner saw.

const proposalsDir = (ref: string) => {
  parseTrackRef(ref);
  return join(codemmHome(), "proposals", ref);
};
const byCodeUnit = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);

/** SHA-256 over the canonical file map: entries sorted by path. */
export const fileMapDigest = (files: FileMap) => digestText(JSON.stringify(Object.entries(files).sort(byCodeUnit)));

/** Renames a folder aside, then deletes it, so a half-deleted folder is never read as a proposal. */
function discard(dir: string): void {
  if (!existsSync(dir)) return;
  const aside = join(dirname(dir), `.discard-${randomBytes(4).toString("hex")}`);
  renameSync(dir, aside);
  rmSync(aside, { recursive: true, force: true });
}

/** Stores a proposal and drops older ones for the same track. Call while holding the track lock. */
export function writeProposal(ref: string, files: FileMap): void {
  const digest = fileMapDigest(files);
  const dir = proposalsDir(ref);
  if (!existsSync(join(dir, digest))) {
    // The files sit in their own folder, so no track file can collide with proposal.json.
    const payload = Object.fromEntries(Object.entries(files).map(([path, text]) => [`files/${path}`, text]));
    commitFolder(join(dir, digest), payload, { "proposal.json": { format_version: 1, track: ref, digest, created: new Date().toISOString() } });
  }
  for (const other of readdirSync(dir)) if (!other.startsWith(".") && other !== digest) discard(join(dir, other));
}

/** Every proposal with its files. One that another process removes while this reads it is left out. */
export function listProposals(): { record: ProposalRecord; files: FileMap }[] {
  const root = join(codemmHome(), "proposals");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((ref) => !ref.startsWith("."))
    .sort()
    .flatMap((ref) => {
      let dirs: string[];
      try {
        dirs = readdirSync(join(root, ref)).filter((d) => !d.startsWith("."));
      } catch (e) {
        if (!existsSync(join(root, ref))) return [];
        throw e;
      }
      return dirs.flatMap((d) => {
        const dir = join(root, ref, d);
        try {
          return [{ record: parseRecord(ProposalRecord, join(dir, "proposal.json")), files: readFileMap(join(dir, "files")) }];
        } catch (e) {
          if (!existsSync(dir)) return [];
          throw e;
        }
      });
    });
}

/** The proposal's files, or undefined if no proposal has that digest. */
export function readProposal(ref: string, digest: string): FileMap | undefined {
  if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
  const dir = join(proposalsDir(ref), digest, "files");
  return existsSync(dir) ? readFileMap(dir) : undefined;
}

export const dropProposals = (ref: string) => discard(proposalsDir(ref));

/** Setup needs room for an image: refuse to build when the volume holding `dir` is nearly full. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
export function assertFreeSpace(dir: string, min = MIN_FREE_BYTES): void {
  mkdirSync(dir, { recursive: true });
  const { bavail, bsize } = statfsSync(dir);
  if (bavail * bsize < min) {
    throw infraError(`Not enough disk space. Setup needs ${Math.round(min / 1024 ** 3)} GB free where Codemm keeps its data (${dir}). Free some space, then try again.`, "host-disk");
  }
}

// ---------- courses and exercises ----------

export function readCourse(course: string): CourseRecord | undefined {
  const file = join(courseDir(course), "course.json");
  if (!existsSync(file)) return undefined;
  return parseRecord(CourseRecord, file);
}

export const writeCourse = (record: CourseRecord) => writeJsonAtomic(join(courseDir(record.course), "course.json"), record);

export function listCourses(): string[] {
  const dir = join(codemmHome(), "courses");
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : [];
}

export const exerciseDir = (course: string, slug: string) => {
  assertId("slug", slug);
  return join(courseDir(course), "exercises", slug);
};

export function listExercises(course: string): ExerciseRecord[] {
  const dir = join(courseDir(course), "exercises");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((slug) => parseRecord(ExerciseRecord, join(dir, slug, "exercise.json")))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readExercise(course: string, slug: string): { record: ExerciseRecord; files: FileMap } {
  const dir = exerciseDir(course, slug);
  if (!existsSync(join(dir, "exercise.json"))) throw new CodemmError(`No exercise "${slug}" in course "${course}".`);
  // Codemm's generated record is read on its own so it never counts against the author's limits.
  const record = parseRecord(ExerciseRecord, join(dir, "exercise.json"));
  return { record, files: readFileMap(dir, ["exercise.json"]) };
}

// ---------- lessons ----------

export const lessonDir = (course: string, id: string) => {
  assertId("lesson id", id);
  return join(courseDir(course), "lessons", id);
};

/** Lessons in the order they were saved. */
export function listLessons(course: string): LessonRecord[] {
  const dir = join(courseDir(course), "lessons");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((id) => parseRecord(LessonRecord, join(dir, id, "lesson.json")))
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/** The agent's text never changes after saving; the learner's notes sit beside it. */
export function readLesson(course: string, id: string): { record: LessonRecord; markdown: string; notes: string; examples: FileMap[] } {
  const dir = lessonDir(course, id);
  if (!existsSync(join(dir, "lesson.json"))) throw new CodemmError(`No lesson "${id}" in course "${course}".`);
  const record = parseRecord(LessonRecord, join(dir, "lesson.json"));
  return {
    record,
    markdown: readFileSync(join(dir, "lesson.md"), "utf8"),
    notes: readFileSync(join(dir, "notes.md"), "utf8"),
    examples: Array.from({ length: record.examples ?? 0 }, (_, i) => readFileMap(join(dir, "examples", String(i + 1)))),
  };
}

/** The lesson's text, empty notes and its examples under examples/<n>/, in one atomic folder. */
export function writeLesson(course: string, record: LessonRecord, markdown: string, examples: FileMap[] = []): void {
  const files: FileMap = { "lesson.md": markdown, "notes.md": "" };
  examples.forEach((example, i) => {
    for (const [path, text] of Object.entries(example)) files[`examples/${i + 1}/${path}`] = text;
  });
  commitFolder(lessonDir(course, record.id), files, { "lesson.json": record });
}

export const writeNotes = (course: string, id: string, text: string) => writeTextAtomic(join(lessonDir(course, id), "notes.md"), text);

// ---------- events ----------

const eventsFile = (course: string) => join(courseDir(course), "events.jsonl");

/** Reads the log. A torn final line (crash mid-append) is ignored; any other bad line is an error. */
export function readEvents(course: string): LearnerEvent[] {
  const file = eventsFile(course);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const torn = !text.endsWith("\n") && text.length > 0;
  const events: LearnerEvent[] = [];
  lines.forEach((line, i) => {
    if (line === "" || (torn && i === lines.length - 1)) return;
    try {
      events.push(LearnerEventSchema.parse(JSON.parse(line)));
    } catch {
      throw new CodemmError(`The learning log ${file} has an invalid entry on line ${i + 1}. Fix or remove that line, then retry.`, "damaged");
    }
  });
  return events;
}

export function appendEvent(course: string, event: LearnerEvent): void {
  const file = eventsFile(course);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    readEvents(course); // refuses interior corruption
    const text = readFileSync(file, "utf8");
    if (text.length > 0 && !text.endsWith("\n")) {
      copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      truncateSync(file, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
    }
  }
  writeFileSync(file, `${JSON.stringify(LearnerEventSchema.parse(event))}\n`, { flag: "a" });
}

// ---------- workspace ----------

const workspaceFile = (ws: string) => join(ws, "codemm.json");

export function readWorkspace(ws: string): WorkspaceConfig {
  const file = workspaceFile(ws);
  if (!existsSync(file)) return { format_version: 1, assist: false };
  return parseRecord(WorkspaceConfig, file);
}

/**
 * One lock per workspace, however its path is spelled (symlinks, case, Windows short names). The folder is
 * created first, so the lock's name can't change when it appears.
 */
function workspaceLock(ws: string): string {
  mkdirSync(ws, { recursive: true });
  const id = realpathSync.native(ws);
  return join(codemmHome(), "locks", `ws-${createHash("sha256").update(id).digest("hex").slice(0, 16)}.lock`);
}

/** Serializes changes Codemm makes to one workspace (codemm.json, host setup). */
export const withWorkspaceLock = <T>(ws: string, work: () => Promise<T>) => withLock(workspaceLock(ws), work);

/**
 * Read-modify-write of codemm.json, serialized across processes. `change` may take the course lock (workspace, then
 * course: nothing takes them the other way round) to record something that must agree with the change.
 */
export async function updateWorkspace(ws: string, change: (config: WorkspaceConfig) => WorkspaceConfig | Promise<WorkspaceConfig>): Promise<WorkspaceConfig> {
  return withWorkspaceLock(ws, async () => {
    const next = await change(readWorkspace(ws));
    writeJsonAtomic(workspaceFile(ws), next);
    return next;
  });
}

/** Fails if `path`'s real location escapes `root` (a symlinked ancestor). */
function assertInside(root: string, path: string): void {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new CodemmError(`Refusing to follow a symlink out of ${root}.`);
}

/** The absolute path of `ws/rel`, refusing it if any existing component is a symlink. */
export function refuseSymlinks(ws: string, rel: string): string {
  let current = ws;
  for (const part of rel.split("/")) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new CodemmError(`Refusing to write through the symlink at ${current}. Replace it with a real folder or file, then retry.`);
    }
  }
  return current;
}

/**
 * Writes learner-side files under `ws/rel`, creating only what's missing.
 * Never overwrites the learner's edits and never writes through a symlink.
 */
export function materialize(ws: string, rel: string, files: FileMap): void {
  // Generated from already-validated data, so only paths are checked, not author size limits.
  for (const path of Object.keys(files)) assertRelativePath(path);
  for (const [path, contents] of Object.entries(files)) {
    const current = refuseSymlinks(ws, `${rel}/${path}`);
    if (existsSync(current)) continue;
    mkdirSync(dirname(current), { recursive: true });
    assertInside(ws, dirname(current));
    // Write a complete temp file, then hard-link it into place: the file appears whole or not at all,
    // and linking fails rather than replacing anything that appeared in the meantime.
    const tmp = writeTempBeside(current, contents, 0o644);
    try {
      linkSync(tmp, current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      unlinkSync(tmp);
    }
  }
}

export const digestText = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Replaces one learner file through a temp file and a rename, but only if it still has the `digest` the
 * editor loaded. Never writes through a symlink. Call while holding the workspace lock.
 */
export function replaceLearnerFile(ws: string, rel: string, name: string, text: string, digest: string): string {
  assertRelativePath(name);
  const path = refuseSymlinks(ws, `${rel}/${name}`);
  const current = existsSync(path) ? readLearnerFiles(ws, rel, [name])[name] : undefined;
  if (current === undefined || digestText(current) !== digest) throw new CodemmError(`Changed outside Codemm. Reload ${name}.`, "changed");
  writeTextAtomic(path, text, 0o644);
  return digestText(text);
}

/** Reads the learner's files for an exercise; refuses missing files and symlinks. */
export function readLearnerFiles(ws: string, rel: string, names: string[]): FileMap {
  const out: FileMap = {};
  for (const name of names) {
    const path = join(ws, rel, name);
    if (!existsSync(path)) throw new CodemmError(`${join(rel, name)} is missing. Restore it, or run get_exercise to recreate the starter.`);
    if (!lstatSync(path).isFile()) throw new CodemmError(`${join(rel, name)} must be a regular file, not a symlink or folder.`);
    assertInside(ws, dirname(path));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      out[name] = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  return validateFileMap(out);
}
