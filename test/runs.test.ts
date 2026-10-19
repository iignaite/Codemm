import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAbandonedRuns, runsDir, stageRunFolder } from "../src/runs.js";
import { tempDir } from "./temp.js";

/** Run folders (DESIGN §4.3): where the files a container mounts are staged. */

let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_HOME", home);
});
afterEach(() => vi.unstubAllEnvs());

/** A PID that belonged to a Codemm process that has since exited. */
const deadPid = () => {
  const r = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  return Number(r.stdout.trim());
};

describe("stageRunFolder", () => {
  it("makes a fresh folder under Codemm's home, not the OS temp folder, named after its owner", () => {
    const a = stageRunFolder();
    const b = stageRunFolder();
    expect(a.dir).not.toBe(b.dir);
    expect(dirname(a.dir)).toBe(join(realpathSync.native(home), "runs"));
    expect(basename(a.dir)).toMatch(new RegExp(`^${process.pid}-`));
    expect(statSync(a.dir).isDirectory()).toBe(true);
  });

  it("uses the real path, so a linked home (or a Windows short name) is never what the engine is asked to mount", () => {
    const link = join(tempDir("codemm-link-"), "home-link");
    symlinkSync(home, link);
    vi.stubEnv("CODEMM_HOME", link);
    expect(runsDir()).toBe(join(realpathSync.native(home), "runs"));
    expect(stageRunFolder().dir.startsWith(join(realpathSync.native(home), "runs"))).toBe(true);
  });

  it("works with a home folder that doesn't exist yet and a non-ASCII name", () => {
    vi.stubEnv("CODEMM_HOME", join(home, "Ñandú", "José Müller"));
    const run = stageRunFolder();
    expect(existsSync(run.dir)).toBe(true);
    expect(run.dir).toContain("José Müller");
  });

  it("removes the folder with its contents, and removing twice is fine", () => {
    const run = stageRunFolder();
    mkdirSync(join(run.dir, "src"));
    writeFileSync(join(run.dir, "src", "main.py"), "x");
    run.remove();
    expect(existsSync(run.dir)).toBe(false);
    expect(() => run.remove()).not.toThrow();
  });
});

describe("leftover run folders", () => {
  const leftover = (name: string) => {
    const dir = join(runsDir(), name);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "01.in"), "hidden");
    return dir;
  };

  it("are removed when their Codemm process is gone, and a live process's folders are left alone", () => {
    const crashed = leftover(`${deadPid()}-abc123`);
    const live = leftover(`${process.ppid}-abc123`);
    const mine = stageRunFolder();
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(mine.dir)).toBe(true);
  });

  it("removeAbandonedRuns says how many it removed, and never touches what Codemm didn't make", () => {
    mkdirSync(runsDir(), { recursive: true });
    const gone = deadPid();
    leftover(`${gone}-aaaaaa`);
    leftover(`${gone}-bbbbbb`);
    // Not run folders: another name, a name that only starts with a PID, a file and a link with the right name.
    writeFileSync(join(runsDir(), "notes.txt"), "mine");
    mkdirSync(join(runsDir(), "keep-me"));
    mkdirSync(join(runsDir(), `${gone}`));
    mkdirSync(join(runsDir(), "2024-05-01"));
    mkdirSync(join(runsDir(), `${gone}-cccccc-more`));
    writeFileSync(join(runsDir(), `${gone}-dddddd`), "a file");
    const target = tempDir("codemm-target-");
    writeFileSync(join(target, "keep"), "x");
    symlinkSync(target, join(runsDir(), `${gone}-eeeeee`));
    expect(removeAbandonedRuns()).toBe(2);
    expect(readdirSync(runsDir()).sort()).toEqual(["2024-05-01", `${gone}`, `${gone}-cccccc-more`, `${gone}-dddddd`, `${gone}-eeeeee`, "keep-me", "notes.txt"].sort());
    expect(existsSync(join(target, "keep"))).toBe(true);
    expect(removeAbandonedRuns()).toBe(0);
  });

  it("removeAbandonedRuns needs no runs folder", () => {
    expect(existsSync(join(realpathSync.native(home), "runs"))).toBe(false);
    expect(removeAbandonedRuns()).toBe(0);
  });
});
