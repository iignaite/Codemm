/** Reads what a run left in Codemm's store and the workspace. Read-only. */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FileMap = Record<string, string>;
export type StoredTrack = { ref: string; image: string; imageId: string; files: string[] };
export type StoredExercise = { course: string; slug: string; style: string; track: string; files: FileMap; expected: Record<string, string>; hiddenNames: string[] };
export type Evidence = { tracks: StoredTrack[]; course?: string; exercises: StoredExercise[]; workspace: FileMap };

/** Every regular file under `dir`, keyed by `/`-separated path relative to `dir`, prefixed with `prefix`. */
export function readDirMap(dir: string, prefix = ""): FileMap {
  const out: FileMap = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) Object.assign(out, readDirMap(path, `${prefix}${name}/`));
    else if (st.isFile()) out[`${prefix}${name}`] = readFileSync(path, "utf8");
  }
  return out;
}

const readJson = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
const dirs = (path: string) => (existsSync(path) ? readdirSync(path).filter((n) => !n.startsWith(".") && lstatSync(join(path, n)).isDirectory()) : []);

export function readEvidence(home: string, ws: string): Evidence {
  const tracks = dirs(join(home, "tracks")).flatMap((ref) => {
    const t = readJson(join(home, "tracks", ref, "track.json"));
    return t ? [{ ref, image: t.image, imageId: t.imageId, files: t.files }] : [];
  });
  const exercises: StoredExercise[] = [];
  for (const course of dirs(join(home, "courses"))) {
    for (const slug of dirs(join(home, "courses", course, "exercises"))) {
      const dir = join(home, "courses", course, "exercises", slug);
      const record = readJson(join(dir, "exercise.json"));
      if (!record) continue;
      const files = readDirMap(dir);
      delete files["exercise.json"];
      exercises.push({ course, slug, style: record.style, track: record.track, files, expected: record.expected ?? {}, hiddenNames: record.inventory?.hidden ?? [] });
    }
  }
  return { tracks, course: readJson(join(ws, "codemm.json"))?.course, exercises, workspace: readDirMap(join(ws, "exercises"), "exercises/") };
}
