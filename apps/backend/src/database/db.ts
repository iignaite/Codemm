import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";

// Load `.env` early so CODEMM_DB_PATH can be used even when this module is imported before `dotenv.config()`.
dotenv.config();

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveDirPath(p: string): string {
  const expanded = expandTilde(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function resolveDbFilePath(p: string): string {
  const resolved = resolveDirPath(p);
  ensureDir(path.dirname(resolved));
  return resolved;
}

function pickWritableDataDir(preferredDir: string): string {
  try {
    ensureDir(preferredDir);
    return preferredDir;
  } catch (err) {
    const cwdDir = path.join(process.cwd(), ".codemm");
    try {
      ensureDir(cwdDir);
      // eslint-disable-next-line no-console
      console.warn(`[db] Falling back to writable data dir: ${cwdDir} (preferred failed: ${preferredDir})`, err);
      return cwdDir;
    } catch {
      const tmpDir = path.join(os.tmpdir(), "codemm");
      ensureDir(tmpDir);
      // eslint-disable-next-line no-console
      console.warn(`[db] Falling back to temp data dir: ${tmpDir} (preferred failed: ${preferredDir})`, err);
      return tmpDir;
    }
  }
}

function getDefaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Codemm");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Codemm");
  }

  const xdg = typeof process.env.XDG_DATA_HOME === "string" ? process.env.XDG_DATA_HOME.trim() : "";
  if (xdg) return path.join(xdg, "codemm");
  return path.join(os.homedir(), ".local", "share", "codemm");
}

const envDbPath = process.env.CODEMM_DB_PATH;
const envDbDir = process.env.CODEMM_DB_DIR;
let dbPath: string;

if (typeof envDbPath === "string" && envDbPath.trim()) {
  const trimmed = envDbPath.trim();
  dbPath = trimmed === ":memory:" ? ":memory:" : resolveDbFilePath(trimmed);
} else {
  const dataDir =
    typeof envDbDir === "string" && envDbDir.trim()
      ? resolveDirPath(envDbDir.trim())
      : pickWritableDataDir(getDefaultDataDir());

  ensureDir(dataDir);
  dbPath = path.join(dataDir, "codemm.db");
}

let db: Database.Database;
try {
  db = new Database(dbPath);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`[db] Failed to open SQLite DB at: ${dbPath}`);
  throw err;
}

db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

export default db;
