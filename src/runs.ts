// Run folders (DESIGN §4.3): where a check, Run and the self-test stage the files they mount into a container.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codemmHome, processAlive } from "./store.js";

/**
 * `<real Codemm home>/runs`. It's under Codemm's home, not the OS temp folder: an engine that runs in a VM (Colima,
 * Rancher Desktop, Podman) shares only the home folder by default, and not macOS's /var/folders, so a bind mount
 * from there fails. It's the real path, so a linked home, a Windows short name (JOHNSM~1) or a non-ASCII folder
 * is what the engine is asked to mount.
 */
export function runsDir(): string {
  mkdirSync(codemmHome(), { recursive: true });
  return join(realpathSync.native(codemmHome()), "runs");
}

export type RunFolder = { dir: string; remove(): void };

/**
 * A fresh folder for one container run, named after the Codemm process that owns it (`<pid>-<random>`), so a crash
 * leaves a folder that the next run can tell is abandoned. Folders of crashed processes are removed first.
 */
export function stageRunFolder(): RunFolder {
  const root = runsDir();
  mkdirSync(root, { recursive: true });
  removeAbandonedRuns();
  const dir = mkdtempSync(join(root, `${process.pid}-`));
  // Best effort: a folder that can't be removed now (Windows, while the engine lets go) must not fail the run or
  // hide its result. It's removed with the other leftovers once this process is gone.
  return { dir, remove: () => removeFolder(dir) };
}

function removeFolder(dir: string): boolean {
  try {
    writable(dir);
  } catch {
    // Gone already, or not Codemm's to change: removing says which.
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives a run folder write permission back: the WASI engine makes it read-only (wasi.ts), and neither POSIX (a 0555
 * folder) nor Windows (a read-only file) lets it be removed then. Links and special files are left as they are.
 */
function writable(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) writable(path);
    else if (entry.isFile()) chmodSync(path, 0o600);
  }
}

/** What `mkdtemp` makes of `<pid>-`: the PID, then six letters or digits. Nothing else in `runs/` is Codemm's to remove. */
const RUN_FOLDER = /^(\d+)-[A-Za-z0-9]{6}$/;

/** Removes the run folders whose Codemm process is gone, as the containers are (DESIGN §10). Live processes' folders are never touched. */
export function removeAbandonedRuns(): number {
  const root = runsDir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const owner = RUN_FOLDER.exec(name)?.[1];
    if (owner === undefined || processAlive(Number(owner))) continue;
    // A real folder only: a link or a file with this name isn't one Codemm made.
    try {
      if (!lstatSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (removeFolder(join(root, name))) removed++;
  }
  return removed;
}
