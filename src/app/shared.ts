import { existsSync } from "node:fs";
import { join } from "node:path";
import { CodemmError } from "../errors.js";
import { subMap } from "../files.js";
import { assertRuntime, inspectImage } from "../sandbox.js";
import { type CourseRecord, type TrackRecord } from "../schemas.js";
import * as store from "../store.js";
import type { TrackContract } from "./exercises.js";

export const learnerDir = (course: string, slug: string) => `exercises/${course}/${slug}`;

export function activeCourse(ws: string, bound?: string): CourseRecord {
  const course = bound ?? store.readWorkspace(ws).course;
  if (!course) throw new CodemmError("No course in this workspace yet. Ask your agent to plan a roadmap (save_roadmap).", "no-course");
  const record = store.readCourse(course);
  if (!record) throw new CodemmError(`Course "${course}" is missing from ${store.codemmHome()}.`, "no-course");
  return record;
}

export function installedTrack(ref: string): TrackRecord {
  const track = store.readTrack(ref);
  if (!track) throw new CodemmError(`Track ${ref} is not installed. Install it first (save_track).`);
  return track;
}

/**
 * Fails, without recording anything, when what the track runs on isn't there: the runtime or the verified image, or a
 * WASI track's toolchain folder (DESIGN §4.5).
 */
export async function ensureImage(track: TrackRecord): Promise<void> {
  const ref = `${track.id}@${track.version}`;
  const rebuild = `Run \`codemm track rebuild ${ref}\`, then retry.`;
  if (track.wasi) {
    if (!existsSync(join(store.toolchainDir(track.wasi.sha256), track.wasi.module))) throw new CodemmError(`The toolchain for ${ref} is missing. ${rebuild}`, "image-missing");
    return;
  }
  await assertRuntime();
  const info = await inspectImage(track.imageId);
  if (!info) throw new CodemmError(`The image for ${ref} is missing or changed. ${rebuild}`, "image-missing");
}

/** A progress listener that throws is dropped; the work goes on. */
export function quietly<T>(listener?: (p: T) => void): ((p: T) => void) | undefined {
  let heard = listener;
  return heard && ((p: T) => {
    try {
      heard?.(p);
    } catch {
      heard = undefined;
    }
  });
}

export function trackContract(track: TrackRecord, style: string): TrackContract {
  const files = store.readTrackFiles(`${track.id}@${track.version}`);
  const commands = style === "io" ? { ...(track.build ? { build: track.build } : {}), run: track.run } : { test: track.test };
  return {
    files: track.files,
    ...commands,
    limits: track.limits,
    examples: { solution: subMap(files, `probe/${style}/pass`), tests: subMap(files, `probe/${style}/tests`) },
  };
}

/** Appends an assist event if the exercise has none. Call only while holding the course lock. */
export function noteAssistLocked(course: string, slug: string): void {
  if (!store.readEvents(course).some((e) => e.kind === "assist" && e.exercise === slug)) {
    store.appendEvent(course, { format_version: 1, kind: "assist", at: new Date().toISOString(), exercise: slug });
  }
}
