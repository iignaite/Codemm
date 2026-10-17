import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertId, readFileMap, validateFileMap } from "../src/files.js";

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

  it("rejects maps over the size limit", () => {
    expect(() => validateFileMap({ big: "x".repeat(1_048_577) })).toThrow(/1 MB/);
  });

  it("rejects too many files", () => {
    const map = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`f${i}`, ""]));
    expect(() => validateFileMap(map)).toThrow(/256/);
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

  it("refuses FIFOs and other special files without reading them", () => {
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
