import { CodemmError, infraError } from "../errors.js";
import { assertPortablePaths, type FileMap, validateFileMap } from "../files.js";
import { checkTrackFiles, type TrackProgress, verifyExercise, verifyTrack } from "../gates.js";
import { type Expected, expectedDigest } from "../grading.js";
import { missingBaseImages, runtimeCode, runtimeDown, cli as sandboxCli } from "../sandbox.js";
import { type TrackRecord } from "../schemas.js";
import * as store from "../store.js";
import { installedTrack, quietly } from "./shared.js";

// ---------- tracks ----------

export function listTracks() {
  return store.listTracks().map((t) => ({ track: `${t.id}@${t.version}`, styles: t.styles, files: t.files }));
}

/** Track gate 1, part one: the files are valid, with a Dockerfile and complete probes, and name an id@version. */
function readTrackSpec(files: FileMap) {
  assertPortablePaths(validateFileMap(files));
  const { spec } = checkTrackFiles(files);
  return { spec, ref: `${spec.id}@${spec.version}` };
}

/** Track gate 1, part two, under the track lock: true when these files are installed, an error when others are. */
function alreadyInstalled(ref: string, version: number, files: FileMap): boolean {
  if (!store.readTrack(ref)) return false;
  if (JSON.stringify(sorted(store.readTrackFiles(ref))) === JSON.stringify(sorted(files))) return true;
  throw new CodemmError(`${ref} is already installed with different files. Save your changes as version ${version + 1}.`);
}

/** Gates 2 to 5, then an atomic install. Call while holding the track lock. */
async function install(ref: string, files: FileMap, onProgress?: (p: TrackProgress) => void): Promise<{ installed: string; warning?: string }> {
  // Before building, and again before committing. Roadmap saves check styles under this same track lock,
  // so no course can change style in between.
  assertCoursesFit(ref, readTrackSpec(files).spec.styles);
  const verified = await verifyTrack(files, undefined, onProgress);
  assertCoursesFit(ref, verified.spec.styles);
  const record: TrackRecord = {
    format_version: 1, ...verified.spec, image: verified.image, imageId: verified.imageId, installedAt: new Date().toISOString(),
  };
  store.commitFolder(store.trackDir(ref), files, { "track.json": record });
  return { installed: ref, ...(verified.warning ? { warning: verified.warning } : {}) };
}

/**
 * Every course pinned to `ref` must find its style in the track, or it could never continue. A course's roadmap
 * may name a track before it's installed (DESIGN §5), so this is checked at install, and early when proposing.
 */
function assertCoursesFit(ref: string, styles: string[]): void {
  for (const id of store.listCourses()) {
    const course = store.readCourse(id);
    if (course?.track === ref && !styles.includes(course.style)) {
      throw new CodemmError(`Course "${id}" needs style "${course.style}", but ${ref} offers ${styles.join(", ")}. Add ${course.style} to the track's styles, with its probes.`);
    }
  }
}

export async function saveTrack(files: FileMap): Promise<{ installed: string; unchanged?: true; warning?: string }> {
  const { spec, ref } = readTrackSpec(files);
  return store.withLock(store.trackLockPath(spec.id), async () => {
    if (alreadyInstalled(ref, spec.version, files)) return { installed: ref, unchanged: true as const };
    return install(ref, files);
  });
}

/** io expected outputs as they're compared: by the digest of each, normalized (DESIGN §4.2), in name order. */
const digests = (expected: Record<string, Expected> | undefined) =>
  Object.entries(expected ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, e]) => [name, expectedDigest(e)]);

const sorted = (map: FileMap) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

// ---------- setup proposals (desktop) ----------
//
// In the desktop app, save_track only proposes. The learner consents in Codemm, and installProposal
// builds exactly the files they were shown, identified by digest.

export async function proposeTrack(files: FileMap): Promise<{ installed: string; unchanged: true } | { proposed: string; note: string }> {
  const { spec, ref } = readTrackSpec(files);
  assertCoursesFit(ref, spec.styles);
  // A base image that doesn't exist would fail the build after the learner consents, so the agent hears it now.
  const missing = await missingBaseImages(files.Dockerfile ?? "");
  if (missing.length) {
    throw new CodemmError(`The Dockerfile builds from ${missing.join(" and ")}, which the registry doesn't have. Use an image and tag that exist (check its page on the registry), then call save_track again.`);
  }
  return store.withLock(store.trackLockPath(spec.id), async () => {
    if (alreadyInstalled(ref, spec.version, files)) return { installed: ref, unchanged: true as const };
    store.writeProposal(ref, files);
    return { proposed: ref, note: "The learner decides in Codemm. End your turn." };
  });
}

export function listProposals() {
  return store.listProposals().map(({ record, files }) => ({ track: record.track, digest: record.digest, created: record.created, files }));
}

/**
 * Installs a proposal only if its files still have the digest the learner consented to. `onProgress` hears each
 * build step as counts, then the probes; never the build's output.
 */
export async function installProposal(ref: string, digest: string, onProgress?: (p: TrackProgress) => void): Promise<{ installed: string; unchanged?: true; warning?: string }> {
  const { id, version } = store.parseTrackRef(ref);
  return store.withLock(store.trackLockPath(id), async () => {
    const files = store.readProposal(ref, digest);
    if (!files || store.fileMapDigest(files) !== digest || readTrackSpec(files).ref !== ref) {
      throw new CodemmError(`The proposal for ${ref} changed or is gone, so it needs the learner's consent again.`);
    }
    if (alreadyInstalled(ref, version, files)) {
      store.dropProposals(ref);
      return { installed: ref, unchanged: true as const };
    }
    store.assertFreeSpace(store.codemmHome());
    const result = await install(ref, files, quietly(onProgress));
    store.dropProposals(ref);
    return result;
  });
}

export async function dropProposal(ref: string): Promise<void> {
  await store.withLock(store.trackLockPath(store.parseTrackRef(ref).id), async () => store.dropProposals(ref));
}

/** Rebuilds a pruned or changed image and re-runs every gate before trusting it (DESIGN §4.4). */
export async function rebuildTrack(ref: string): Promise<{ rebuilt: string; exercises: number }> {
  const old = installedTrack(ref);
  return store.withLock(store.trackLockPath(old.id), async () => {
    // Build under a candidate tag; the installed tag and ID stay untouched unless every gate passes.
    const candidate = `${old.image}-candidate`;
    const verified = await verifyTrack(store.readTrackFiles(ref), candidate, undefined, { rebuild: true });
    const track: TrackRecord = { ...old, imageId: verified.imageId };
    const changed: string[] = [];
    let count = 0;
    for (const courseId of store.listCourses()) {
      const course = store.readCourse(courseId);
      if (!course) continue;
      for (const ex of store.listExercises(courseId).filter((e) => e.track === ref)) {
        count += 1;
        const { files } = store.readExercise(courseId, ex.slug);
        try {
          const again = await verifyExercise(track, course, files, new Set());
          if (JSON.stringify(digests(again.expected)) !== JSON.stringify(digests(ex.expected)) || JSON.stringify(again.inventory) !== JSON.stringify(ex.inventory)) {
            changed.push(`${courseId}/${ex.slug}: results changed`);
          }
        } catch (e) {
          // This computer's Docker, disk or network failing isn't the image behaving differently.
          if (e instanceof CodemmError && (e.kind === "docker" || e.kind === "disk" || e.kind === "offline")) {
            await sandboxCli(["image", "rm", candidate]);
            throw e;
          }
          changed.push(`${courseId}/${ex.slug}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    if (changed.length > 0) {
      await sandboxCli(["image", "rm", candidate]);
      throw new CodemmError(`The rebuilt image behaves differently, so it wasn't accepted:\n${changed.join("\n")}`);
    }
    const tagged = await sandboxCli(["tag", verified.imageId, old.image]);
    if (tagged.exit !== 0) {
      const down = await runtimeDown();
      if (down) throw infraError(down.message, down.code);
      throw infraError(`Couldn't promote the rebuilt image, so nothing changed: ${tagged.output.trim().slice(0, 300)}`, runtimeCode(tagged.output, "image-id"));
    }
    store.writeTrackRecord(ref, track);
    // The image keeps its installed tag, so dropping the candidate tag only untags it.
    await sandboxCli(["image", "rm", candidate]);
    return { rebuilt: ref, exercises: count };
  });
}
