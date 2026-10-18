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

/**
 * How a path may appear in messages: anything under tests/hidden/ or mutants/ (hidden material) is never echoed. A
 * malformed path ("./tests/hidden/x", "tests//hidden/x", "a\\..\\mutants\\x") is matched by its parts, wherever they are.
 */
export const describePath = (path: string) => {
  const parts = path.split(/[\\/\0]+/).filter((p) => p !== "" && p !== ".").join("/");
  const hidden = /(?:^|\/)(tests\/hidden|mutants)(\/|$)/i.exec(parts);
  return hidden ? `a file under ${hidden[1]!.toLowerCase()}/` : `"${path}"`;
};

export function assertRelativePath(path: string): void {
  const parts = path.split("/");
  const ok = path.length > 0 && !path.includes("\\") && !path.includes("\0") && parts.every((p) => p !== "" && p !== "." && p !== "..");
  if (!ok) throw new CodemmError(`Invalid path ${describePath(path)}. Use a relative path with "/" separators and no "." or ".." parts.`);
}

/**
 * New author input must also be safe to write on Windows, where ":" names a stream or a drive and a trailing
 * "." or " " is dropped, so such a name could overwrite another entry. Stored data keeps the rules above.
 */
export function assertPortablePaths(map: FileMap): FileMap {
  for (const path of Object.keys(map)) {
    if (path.includes(":") || path.split("/").some((p) => /[. ]$/.test(p))) {
      throw new CodemmError(`Invalid path ${describePath(path)}. Names may not contain ":" or end in "." or a space.`);
    }
  }
  return map;
}

export function validateFileMap(map: FileMap): FileMap {
  const entries = Object.entries(map);
  if (entries.length > MAX_FILES) throw new CodemmError(`Too many files (${entries.length}). The limit is ${MAX_FILES}.`);
  let bytes = 0;
  const seen = new Set<string>();
  for (const [path, contents] of entries) {
    assertRelativePath(path);
    // Paths that differ only by case would overwrite each other on macOS and Windows.
    if (seen.has(path.toLowerCase())) throw new CodemmError(`Two files differ only by case (${describePath(path)}). Rename one.`);
    seen.add(path.toLowerCase());
    if (typeof contents !== "string") throw new CodemmError(`File ${describePath(path)} must be text.`);
    bytes += Buffer.byteLength(contents);
  }
  if (bytes > MAX_BYTES) throw new CodemmError(`Files total ${bytes} bytes. The limit is 1 MB.`);
  return map;
}

/**
 * Reads a folder into a file map, enforcing the limits while walking. Only regular files
 * and folders are allowed. `exclude` names top-level files (Codemm's own records) to skip.
 */
export function readFileMap(dir: string, exclude: string[] = []): FileMap {
  const map: FileMap = {};
  let count = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (!rel && exclude.includes(name)) continue;
      const stat = lstatSync(join(dir, relPath));
      if (stat.isSymbolicLink()) throw new CodemmError(`${describePath(relPath)} is a symlink. Copy the file in instead.`);
      if (stat.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!stat.isFile()) throw new CodemmError(`${describePath(relPath)} isn't a regular file.`);
      count += 1;
      bytes += stat.size;
      if (count > MAX_FILES) throw new CodemmError(`Too many files (over ${MAX_FILES}).`);
      if (bytes > MAX_BYTES) throw new CodemmError(`Files total over 1 MB. The limit is 1 MB.`);
      map[relPath] = readFileSync(join(dir, relPath), "utf8");
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
