import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveExercise, saveTrack } from "../src/app.js";
import { assertId, assertPortablePaths, readFileMap, validateFileMap } from "../src/files.js";

describe("assertId", () => {
  it.each(["c", "react", "python3", "c.loops", "sum-evens_2"])("accepts %s", (id) => {
    expect(() => assertId("slug", id)).not.toThrow();
  });

  it.each(["", "Upper", "../etc", "a/b", "-lead", "x".repeat(65), "has space"])("rejects %j", (id) => {
    expect(() => assertId("slug", id)).toThrow(/slug/);
  });
});

describe("validateFileMap", () => {
  it("accepts nested relative paths", () => {
    expect(validateFileMap({ "README.md": "hi", "solution/main.c": "int main(){}" })).toEqual({
      "README.md": "hi",
      "solution/main.c": "int main(){}",
    });
  });

  it.each(["/etc/passwd", "../x", "a/../../x", "a\\b", "a//b", "", "a/./b"])("rejects path %j", (path) => {
    expect(() => validateFileMap({ [path]: "x" })).toThrow(/path/i);
  });

  it("never echoes a path under tests/hidden/", () => {
    expect(() => validateFileMap({ "tests/hidden/secret-name/../x": "x" })).toThrow(/under tests\/hidden/);
    expect(() => validateFileMap({ "tests/hidden/secret-name/../x": "x" })).not.toThrow(/secret-name/);
  });

  it("rejects paths that differ only by case", () => {
    expect(() => validateFileMap({ "Main.c": "a", "main.c": "b" })).toThrow(/case/);
  });

  it("rejects maps over the size limit", () => {
    expect(() => validateFileMap({ big: "x".repeat(1_048_577) })).toThrow(/1 MB/);
  });

  it("rejects too many files", () => {
    const map = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, ""]));
    expect(() => validateFileMap(map)).toThrow(/256/);
  });
});

// On Windows these name the same file as another entry (or a hidden stream of it), so one could overwrite another.
const WINDOWS_ALIASES = ["main.sh::$DATA", "notes.txt:meta", "C:x", "main.sh.", "src /main.sh"];

describe("portable author input", () => {
  it.each(WINDOWS_ALIASES)("rejects the Windows alias %j", (path) => {
    expect(() => assertPortablePaths({ [path]: "x" })).toThrow(/Invalid path/);
  });

  it("keeps names already stored on POSIX readable", () => {
    expect(() => validateFileMap({ "fixture:one.json": "x", "data./input.txt": "y" })).not.toThrow();
  });

  it("is enforced when a track or an exercise is saved, before anything runs", async () => {
    process.env.CODEMM_HOME = mkdtempSync(join(tmpdir(), "codemm-home-"));
    await expect(saveTrack({ "track.yaml": "id: x\n", "run.sh:x": "" })).rejects.toThrow(/Invalid path/);
    await expect(saveExercise(mkdtempSync(join(tmpdir(), "codemm-ws-")), { "exercise.yaml": "", "notes.": "" })).rejects.toThrow(/Invalid path/);
  });
});

describe("readFileMap", () => {
  it("reads a directory tree into a file map", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-files-"));
    mkdirSync(join(dir, "solution"));
    writeFileSync(join(dir, "README.md"), "hi");
    writeFileSync(join(dir, "solution", "main.c"), "x");
    expect(readFileMap(dir)).toEqual({ "README.md": "hi", "solution/main.c": "x" });
  });

  // Windows has no FIFOs (Git for Windows' mkfifo makes a plain file).
  it.skipIf(process.platform === "win32")("refuses FIFOs and other special files without reading them", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-files-"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    expect(() => readFileMap(dir)).toThrow(/regular file/i);
  });

  it("stops at the limits while walking instead of reading everything first", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-files-"));
    writeFileSync(join(dir, "big"), Buffer.alloc(2_000_000));
    expect(() => readFileMap(dir)).toThrow(/1 MB/);
  });

  it("can leave out generated records so they don't count against author limits", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-files-"));
    writeFileSync(join(dir, "exercise.json"), "x".repeat(2_000_000));
    writeFileSync(join(dir, "README.md"), "hi");
    expect(readFileMap(dir, ["exercise.json"])).toEqual({ "README.md": "hi" });
  });

  it("refuses symlinks so input can't point outside its folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-files-"));
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    expect(() => readFileMap(dir)).toThrow(/symlink/i);
  });
});
