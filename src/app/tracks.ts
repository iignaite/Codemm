import { CodemmError, infraError } from "../errors.js";
import { assertPortablePaths, type FileMap, validateFileMap } from "../files.js";
import { checkTrackFiles, type TrackProgress, verifyExercise, verifyTrack } from "../gates.js";
import { type Expected, expectedDigest } from "../grading.js";
import { containerCli, missingBaseImages, runtimeCode, runtimeDown, cli as sandboxCli } from "../sandbox.js";
import { parseTrackYaml, type TrackRecord, type TrackSpec } from "../schemas.js";
import * as store from "../store.js";
import { wasmtimePath } from "../wasi.js";
import { installedTrack, quietly } from "./shared.js";

// ---------- tracks ----------

/** Which engine runs a track (DESIGN §4.5): a wasi block means the WASI engine, anything else Docker. */
const engineOf = (track: { wasi?: unknown }): "docker" | "wasi" => (track.wasi ? "wasi" : "docker");

export function listTracks() {
  return store.listTracks().map((t) => ({ track: `${t.id}@${t.version}`, styles: t.styles, files: t.files, engine: engineOf(t) }));
}

/** Track gate 1, part one: the files are valid, with one engine and complete probes, and name an id@version. */
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
  // A WASI track's url stays in its track.yaml; its record names the toolchain by digest (DESIGN §4.5).
  const { wasi: _url, ...spec } = verified.spec;
  const engine = "wasi" in verified ? { wasi: verified.wasi } : { image: verified.image, imageId: verified.imageId };
  const record: TrackRecord = { format_version: 1, ...spec, ...engine, installedAt: new Date().toISOString() };
  store.commitFolder(store.trackDir(ref), files, { "track.json": record });
  const warning = "warning" in verified ? verified.warning : undefined;
  return { installed: ref, ...(warning ? { warning } : {}) };
}

/**
 * A Docker track can never run on a computer with no container runtime. When that computer has wasmtime, the agent
 * hears it now and writes a WASI track instead (DESIGN §4.5). Only a missing runtime counts: a stopped one can start.
 */
function assertEngineHere(spec: TrackSpec): void {
  if (spec.wasi || hasContainerCli() || !wasmtimePath()) return;
  throw new CodemmError(
    "This computer has no container runtime, so a Docker track can't run here, but it has wasmtime. Write a WASI track " +
      "instead: a wasi block in track.yaml naming a WASI build of the language's interpreter, and no Dockerfile (see the track rules).",
  );
}

function hasContainerCli(): boolean {
  try {
    containerCli();
    return true;
  } catch {
    return false;
  }
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
  assertEngineHere(spec);
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
  assertEngineHere(spec);
  assertCoursesFit(ref, spec.styles);
  // A base image that doesn't exist would fail the build after the learner consents, so the agent hears it now. A
  // WASI track has none: its toolchain is checked by digest when it downloads.
  const missing = spec.wasi ? [] : await missingBaseImages(files.Dockerfile ?? "");
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
  return store.listProposals().map(({ record, files }) => ({
    track: record.track, digest: record.digest, created: record.created, files, engine: engineOf(parseTrackYaml(files["track.yaml"] ?? "")),
  }));
}

/**
 * Installs a proposal only if its files still have the digest the learner consented to. `onProgress` hears each
 * build step as counts, then the probes; never the build's output.
 */
export async function installProposal(ref: string, digest: string, onProgress?: (p: TrackProgress) => void): Promise<{ installed: string; unchanged?: true; warning?: string }> {
  const { id, version } = store.parseTrackRef(ref);
  return store.withLock(store.trackLockPath(id), async () => {
    const files = store.readProposal(ref, digest);
    const read = files && store.fileMapDigest(files) === digest ? readTrackSpec(files) : undefined;
    if (!files || read?.ref !== ref) {
      throw new CodemmError(`The proposal for ${ref} changed or is gone, so it needs the learner's consent again.`);
    }
    if (alreadyInstalled(ref, version, files)) {
      store.dropProposals(ref);
      return { installed: ref, unchanged: true as const };
    }
    // An image needs this room; a WASI toolchain checks its own, smaller, need as it downloads.
    if (!read.spec.wasi) store.assertFreeSpace(store.codemmHome());
    const result = await install(ref, files, quietly(onProgress));
    store.dropProposals(ref);
    return result;
  });
}

export async function dropProposal(ref: string): Promise<void> {
  await store.withLock(store.trackLockPath(store.parseTrackRef(ref).id), async () => store.dropProposals(ref));
}

/**
 * Rebuilds a pruned or changed image, or downloads a missing WASI toolchain again (the same SHA-256), and re-runs every
 * gate before trusting it (DESIGN §4.4, §4.5).
 */
export async function rebuildTrack(ref: string): Promise<{ rebuilt: string; exercises: number }> {
  const old = installedTrack(ref);
  return store.withLock(store.trackLockPath(old.id), async () => {
    if (old.wasi) {
      // The toolchain is named by its digest, so there is nothing to promote: the gates only have to pass on it again.
      await verifyTrack(store.readTrackFiles(ref), undefined, undefined, { rebuild: true });
      return { rebuilt: ref, exercises: await recheckExercises(ref, old, "toolchain") };
    }
    // Build under a candidate tag; the installed tag and ID stay untouched unless every gate passes.
    const candidate = `${old.image}-candidate`;
    const verified = await verifyTrack(store.readTrackFiles(ref), candidate, undefined, { rebuild: true });
    if (!("imageId" in verified)) throw new CodemmError(`${ref} is installed as a Docker track, but its files now describe a WASI track.`);
    const track: TrackRecord = { ...old, imageId: verified.imageId };
    let count: number;
    try {
      count = await recheckExercises(ref, track, "image");
    } catch (e) {
      await sandboxCli(["image", "rm", candidate]);
      throw e;
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

/**
 * Re-runs exercise gates 2 to 6 for every stored exercise on `track`: io outputs must equal the stored ones and unit
 * inventories must match. Returns how many there were, or fails listing the ones that changed.
 */
async function recheckExercises(ref: string, track: TrackRecord, what: "image" | "toolchain"): Promise<number> {
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
        // This computer's Docker, disk or network failing isn't the track behaving differently.
        if (e instanceof CodemmError && (e.kind === "docker" || e.kind === "disk" || e.kind === "offline")) throw e;
        changed.push(`${courseId}/${ex.slug}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  if (changed.length > 0) throw new CodemmError(`The rebuilt ${what} behaves differently, so it wasn't accepted:\n${changed.join("\n")}`);
  return count;
}
