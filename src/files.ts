import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodemmError } from "./errors.js";

/** Relative path → UTF-8 contents. How agents hand Codemm a track or an exercise. */
export type FileMap = Record<string, string>;

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_FILES = 256;
const MAX_BYTES = 1_048_576;

export function assertId(kind: string, value: string): void {
  if (!ID_PATTERN.test(value) || value.includes("..")) {
    throw new CodemmError(`Invalid ${kind} "${value}". Use 1-64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
}

export function assertRelativePath(path: string): void {
  const parts = path.split("/");
  const ok = path.length > 0 && !path.includes("\\") && !path.includes("\0") && parts.every((p) => p !== "" && p !== "." && p !== "..");
  if (!ok) throw new CodemmError(`Invalid path "${path}". Use a relative path with "/" separators and no "." or ".." parts.`);
}

export function validateFileMap(map: FileMap): FileMap {
  const entries = Object.entries(map);
  if (entries.length > MAX_FILES) throw new CodemmError(`Too many files (${entries.length}). The limit is ${MAX_FILES}.`);
  let bytes = 0;
  for (const [path, contents] of entries) {
    assertRelativePath(path);
    if (typeof contents !== "string") throw new CodemmError(`File "${path}" must be text.`);
    bytes += Buffer.byteLength(contents);
  }
  if (bytes > MAX_BYTES) throw new CodemmError(`Files total ${bytes} bytes. The limit is 1 MB.`);
  return map;
}

export function readFileMap(dir: string): FileMap {
  const map: FileMap = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, relPath));
      if (stat.isSymbolicLink()) throw new CodemmError(`"${relPath}" is a symlink. Copy the file in instead.`);
      if (stat.isDirectory()) walk(relPath);
      else map[relPath] = readFileSync(join(dir, relPath), "utf8");
    }
  };
  walk("");
  return validateFileMap(map);
}

export function writeFileMap(dir: string, map: FileMap): void {
  for (const [path, contents] of Object.entries(validateFileMap(map))) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

/** The entries under `prefix/`, with the prefix removed. */
export function subMap(map: FileMap, prefix: string): FileMap {
  const out: FileMap = {};
  for (const [path, contents] of Object.entries(map)) {
    if (path.startsWith(`${prefix}/`)) out[path.slice(prefix.length + 1)] = contents;
  }
  return out;
}
