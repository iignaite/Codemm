/* eslint-disable no-console */
const { app, BrowserWindow, dialog, shell, ipcMain, safeStorage } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { z } = require("zod");
const { LocalLlmOrchestrator } = require("./localLlm/orchestrator");
const { OLLAMA_DEFAULT_URL } = require("./localLlm/ollamaRuntimeDriver");
const { registerWorkspaceIpc } = require("./ipc/workspace");
const { registerLlmIpc } = require("./ipc/llm");
const { registerThreadsIpc } = require("./ipc/threads");
const { registerActivitiesIpc } = require("./ipc/activities");
const { registerJudgeIpc } = require("./ipc/judge");

const DEFAULT_FRONTEND_PORT = Number.parseInt(process.env.CODEMM_FRONTEND_PORT || "3000", 10);

// Keep a global reference so the window isn't garbage-collected on macOS.
/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
let ipcWired = false;
let currentWorkspace = null; // { workspaceDir, workspaceDataDir, backendDbPath, userDataDir }
let engine = null; // { proc, call, onEvent, shutdown }
let localLlmOrchestrator = null;

function getPathKey(env) {
  if (!env || typeof env !== "object") return "PATH";
  const found = Object.keys(env).find((k) => k.toLowerCase() === "path");
  return found || "PATH";
}

function prependToPath(env, dir) {
  const key = getPathKey(env);
  const delim = path.delimiter || ":";
  const cur = typeof env[key] === "string" ? env[key] : "";
  env[key] = cur ? `${dir}${delim}${cur}` : dir;
}

function getNpmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function tryRegisterIpcHandler(channel, handler) {
  try {
    ipcMain.handle(channel, handler);
  } catch (e) {
    // If the handler is already registered (dev reloads, multi-window), ignore.
    // eslint-disable-next-line no-console
    console.warn(`[ide] IPC handler already registered: ${channel}`);
  }
}

function tryRegisterIpcListener(channel, listener) {
  try {
    if (ipcMain.listenerCount(channel) > 0) return;
    ipcMain.on(channel, listener);
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redactSecrets(text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  return raw
    // OpenAI-style keys
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-[REDACTED]")
    // Generic bearer tokens
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [REDACTED]")
    // JSON-ish fields we might accidentally stringify
    .replace(/(\"apiKey\"\s*:\s*\")([^\"]+)(\")/gi, `$1[REDACTED]$3`)
    .replace(/(\"apiKeyEncB64\"\s*:\s*\")([^\"]+)(\")/gi, `$1[REDACTED]$3`);
}

function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function configureElectronStoragePaths() {
  const userDataOverride = typeof process.env.CODEMM_USER_DATA_DIR === "string" ? process.env.CODEMM_USER_DATA_DIR.trim() : "";
  const cacheOverride = typeof process.env.CODEMM_CACHE_DIR === "string" ? process.env.CODEMM_CACHE_DIR.trim() : "";
  const logsOverride = typeof process.env.CODEMM_LOGS_DIR === "string" ? process.env.CODEMM_LOGS_DIR.trim() : "";

  let userDataDir = userDataOverride ? expandTilde(userDataOverride) : app.getPath("userData");
  if (!path.isAbsolute(userDataDir)) userDataDir = path.resolve(userDataDir);

  // Ensure dirs exist before Chromium tries to create caches (prevents noisy "Failed to write ... index file" errors).
  fs.mkdirSync(userDataDir, { recursive: true });
  if (userDataOverride) app.setPath("userData", userDataDir);

  let cacheDir = cacheOverride ? expandTilde(cacheOverride) : path.join(userDataDir, "Cache");
  if (!path.isAbsolute(cacheDir)) cacheDir = path.resolve(cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  app.setPath("cache", cacheDir);

  let logsDir = logsOverride ? expandTilde(logsOverride) : path.join(userDataDir, "Logs");
  if (!path.isAbsolute(logsDir)) logsDir = path.resolve(logsDir);
  fs.mkdirSync(logsDir, { recursive: true });
  app.setPath("logs", logsDir);

  return { userDataDir, cacheDir, logsDir };
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function tryMakeDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.codemm-write-probe-${Date.now()}.txt`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function hashWorkspaceDir(workspaceDir) {
  const normalized = path.resolve(workspaceDir);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function resolveWorkspace({ userDataDir }) {
  const prefsPath = path.join(userDataDir, "prefs.json");
  const prefs = readJsonFile(prefsPath, { v: 1, lastWorkspaceDir: null });

  const explicit = typeof process.env.CODEMM_WORKSPACE_DIR === "string" ? process.env.CODEMM_WORKSPACE_DIR.trim() : "";
  if (explicit) {
    const dir = path.resolve(explicit);
    writeJsonFile(prefsPath, { ...prefs, lastWorkspaceDir: dir });
    return { prefsPath, workspaceDir: dir };
  }

  if (prefs && typeof prefs.lastWorkspaceDir === "string" && prefs.lastWorkspaceDir.trim()) {
    const dir = path.resolve(prefs.lastWorkspaceDir);
    if (fs.existsSync(dir)) return { prefsPath, workspaceDir: dir };
  }

  const picked = await dialog.showOpenDialog({
    title: "Choose a workspace folder",
    properties: ["openDirectory", "createDirectory"],
    message: "Codemm stores threads and runs per workspace.",
  });
  if (picked.canceled || !picked.filePaths?.[0]) {
    return { prefsPath, workspaceDir: null };
  }

  const dir = path.resolve(picked.filePaths[0]);
  writeJsonFile(prefsPath, { ...prefs, lastWorkspaceDir: dir });
  return { prefsPath, workspaceDir: dir };
}

function resolveWorkspaceDataDir({ userDataDir, workspaceDir }) {
  const explicit =
    typeof process.env.CODEMM_WORKSPACE_DATA_DIR === "string"
      ? process.env.CODEMM_WORKSPACE_DATA_DIR.trim()
      : "";
  if (explicit) {
    const dir = path.isAbsolute(explicit) ? path.resolve(explicit) : path.resolve(workspaceDir, explicit);
    if (tryMakeDirWritable(dir)) return dir;
  }

  const local = path.join(workspaceDir, ".codemm");
  if (tryMakeDirWritable(local)) return local;

  const fallback = path.join(userDataDir, "Workspaces", hashWorkspaceDir(workspaceDir));
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function resolveSecretsStorePath({ userDataDir }) {
  return path.join(userDataDir, "secrets.json");
}

function loadSecrets({ userDataDir }) {
  const secretsPath = resolveSecretsStorePath({ userDataDir });
  const data = readJsonFile(secretsPath, { v: 1, llm: null });
  if (!data || data.v !== 1) return { secretsPath, llm: null };
  const llm = data.llm;
  if (!llm || typeof llm !== "object") return { secretsPath, llm: null };

  const provider = typeof llm.provider === "string" ? llm.provider : null;
  const apiKeyEncB64 = typeof llm.apiKeyEncB64 === "string" ? llm.apiKeyEncB64 : null;
  const model = typeof llm.model === "string" ? llm.model : null;
  const baseURL = typeof llm.baseURL === "string" ? llm.baseURL : null;
  const routingProfile =
    llm.routingProfile === "fast_local" ||
    llm.routingProfile === "balanced_local" ||
    llm.routingProfile === "strong_local" ||
    llm.routingProfile === "custom"
      ? llm.routingProfile
      : "auto";
  const roleModels =
    llm.roleModels && typeof llm.roleModels === "object" && !Array.isArray(llm.roleModels) ? llm.roleModels : null;
  const updatedAt = typeof llm.updatedAt === "string" ? llm.updatedAt : null;
  if (!provider) return { secretsPath, llm: null };

  try {
    if (!apiKeyEncB64) {
      return { secretsPath, llm: { provider, apiKey: null, model, baseURL, routingProfile, roleModels, updatedAt } };
    }
    const buf = Buffer.from(apiKeyEncB64, "base64");
    const apiKey = safeStorage.decryptString(buf);
    return { secretsPath, llm: { provider, apiKey, model, baseURL, routingProfile, roleModels, updatedAt } };
  } catch {
    return { secretsPath, llm: null };
  }
}

function saveSecrets({ userDataDir, provider, apiKey, model, baseURL, routingProfile, roleModels }) {
  const secretsPath = resolveSecretsStorePath({ userDataDir });
  const nextModel = typeof model === "string" && model.trim() ? model.trim() : null;
  const nextApiKey = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
  const nextBaseURL = typeof baseURL === "string" && baseURL.trim() ? baseURL.trim() : null;
  const nextRoutingProfile =
    routingProfile === "fast_local" || routingProfile === "balanced_local" || routingProfile === "strong_local" || routingProfile === "custom"
      ? routingProfile
      : "auto";
  const nextRoleModels =
    roleModels && typeof roleModels === "object" && !Array.isArray(roleModels) ? roleModels : null;
  const apiKeyEncB64 = (() => {
    if (!nextApiKey) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is not available on this system.");
    }
    return safeStorage.encryptString(nextApiKey).toString("base64");
  })();
  const updatedAt = new Date().toISOString();
  writeJsonFile(secretsPath, {
    v: 1,
    llm: {
      provider,
      apiKeyEncB64,
      model: nextModel,
      baseURL: nextBaseURL,
      routingProfile: nextRoutingProfile,
      roleModels: nextRoleModels,
      updatedAt,
    },
  });
  return { secretsPath, updatedAt };
}

function clearSecrets({ userDataDir }) {
  const secretsPath = resolveSecretsStorePath({ userDataDir });
  writeJsonFile(secretsPath, { v: 1, llm: null });
  return { secretsPath };
}

function waitForHttpOk(url, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;

  async function once() {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2_000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  return (async () => {
    while (Date.now() < deadline) {
      // Treat any HTTP response as "up" (even 404) because Next.js may respond with redirects/404s.
      if (await once()) return true;
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now();
        console.log(`[ide] Waiting for ${url}...`);
      }
      await sleep(intervalMs);
    }
    return false;
  })();
}

function waitForFrontendReady(frontendUrl, { token, timeoutMs = 180_000, intervalMs = 500 } = {}) {
  const healthUrl = `${frontendUrl}/codemm/health`;
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;

  async function once() {
    return new Promise((resolve) => {
      const req = http.get(healthUrl, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) return resolve(false);
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return resolve(false);
            if (parsed.ok !== true) return resolve(false);
            if (typeof token === "string" && token) {
              return resolve(parsed.token === token);
            }
            return resolve(true);
          } catch {
            return resolve(false);
          }
        });
        res.on("error", () => resolve(false));
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2_000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  return (async () => {
    while (Date.now() < deadline) {
      if (await once()) return true;
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now();
        console.log(`[ide] Waiting for frontend health: ${healthUrl}...`);
      }
      await sleep(intervalMs);
    }
    return false;
  })();
}

function existsExecutable(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    // On Windows, X_OK isn't reliable; existence + file-ness is good enough for our use.
    if (process.platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(cmd, args = ["--version"]) {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  if (res.error && res.error.code === "ENOENT") return false;
  return res.status === 0;
}

function findDockerBinary() {
  if (process.env.DOCKER_PATH && existsExecutable(process.env.DOCKER_PATH)) {
    return process.env.DOCKER_PATH;
  }

  /** @type {string[]} */
  const candidates = [];

  // PATH first (but only if it actually resolves).
  if (commandExists("docker", ["--version"])) candidates.push("docker");

  if (process.platform === "darwin") {
    candidates.push(
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker"
    );
  } else if (process.platform === "win32") {
    candidates.push(
      "C:\\\\Program Files\\\\Docker\\\\Docker\\\\resources\\\\bin\\\\docker.exe",
      "C:\\\\Program Files\\\\Docker\\\\Docker\\\\resources\\\\bin\\\\docker"
    );
  } else {
    // linux + other unix
    candidates.push("/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker");
  }

  for (const c of candidates) {
    if (c === "docker") return "docker";
    if (existsExecutable(c)) return c;
  }

  return null;
}

function checkDockerRunning({ dockerBin, timeoutMs = 8000 }) {
  const res = spawnSync(dockerBin, ["info"], {
    stdio: "pipe",
    timeout: timeoutMs,
    encoding: "utf8",
  });

  if (res.error && res.error.code === "ENOENT") {
    return { ok: false, reason: `Docker binary not found: ${dockerBin}` };
  }
  if (res.error && res.error.code === "ETIMEDOUT") {
    return { ok: false, reason: `Timed out after ${timeoutMs}ms while running "docker info".` };
  }

  if (res.status === 0) return { ok: true, reason: "" };

  const detail = String((res.stderr || res.stdout || "")).trim();
  return {
    ok: false,
    reason: detail || `docker info exited with code ${String(res.status)}`,
  };
}

async function waitForDockerRunning({
  dockerBin,
  totalTimeoutMs = 180_000,
  tryTimeoutMs = 8_000,
  intervalMs = 2_000,
} = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  let lastLogAt = 0;
  /** @type {string} */
  let lastReason = "Not checked yet";

  while (Date.now() < deadline) {
    const r = checkDockerRunning({ dockerBin, timeoutMs: tryTimeoutMs });
    if (r.ok) return { ok: true, reason: "" };
    lastReason = r.reason;

    if (Date.now() - lastLogAt > 5000) {
      lastLogAt = Date.now();
      console.log(`[ide] Docker not ready yet; retrying... (${lastReason})`);
    }

    await sleep(intervalMs);
  }

  return { ok: false, reason: lastReason };
}

function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallthrough
    }
  }
  try {
    // On macOS/Linux, negative PID targets the full process group when spawned with `detached: true`.
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function wireLogs(name, proc) {
  if (!proc) return;
  proc.stdout?.on("data", (buf) => process.stdout.write(`[${name}] ${buf}`));
  proc.stderr?.on("data", (buf) => process.stderr.write(`[${name}] ${buf}`));
}

function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function validate(schema, args) {
  const res = schema.safeParse(args);
  if (!res.success) {
    const msg = res.error.issues?.[0]?.message || "Invalid args.";
    const err = new Error(msg);
    err.name = "ValidationError";
    throw err;
  }
  return res.data;
}

function resolveNodeBin() {
  const override = typeof process.env.CODEMM_NODE_BIN === "string" ? process.env.CODEMM_NODE_BIN.trim() : "";
  return override || "node";
}

function spawnSystemNode(scriptPath, args, { cwd, env, stdio }) {
  const nodeBin = resolveNodeBin();
  return spawn(nodeBin, [scriptPath, ...(args || [])], {
    cwd,
    env,
    // On Windows, `detached: true` + piped stdio can yield `spawn EINVAL` in some setups.
    // We don't need process groups on Windows because we already kill with `taskkill /T`.
    detached: process.platform !== "win32",
    stdio,
    windowsHide: true,
  });
}

function spawnNodeWithElectron(scriptPath, args, { cwd, env, stdio }) {
  return spawn(process.execPath, [scriptPath, ...(args || [])], {
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    detached: process.platform !== "win32",
    stdio,
    windowsHide: true,
  });
}

function startEngineIpc({ backendDir, env, onEvent }) {
  const entry = path.join(backendDir, "ipc-server.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Engine IPC entry not found: ${entry}`);
  }

  const proc = (app.isPackaged ? spawnNodeWithElectron : spawnSystemNode)(entry, [], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  proc.unref();
  wireLogs("engine", proc);

  const pending = new Map();

  const rejectAll = (reason) => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(reason);
    }
    pending.clear();
  };

  proc.on("message", (raw) => {
    if (!isObject(raw)) return;
    if (raw.type === "res" && typeof raw.id === "string") {
      const p = pending.get(raw.id);
      if (!p) return;
      pending.delete(raw.id);
      clearTimeout(p.timeout);
      if (raw.ok === true) p.resolve(raw.result);
      else p.reject(new Error(raw?.error?.message || "Engine error."));
      return;
    }
    if (raw.type === "event") {
      try {
        onEvent(raw);
      } catch {
        // ignore
      }
    }
  });

  proc.on("exit", (code) => {
    rejectAll(new Error(`Engine exited (code=${code ?? "unknown"}).`));
  });
  proc.on("error", (err) => {
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });

  function call(method, params, context) {
    if (!proc || !proc.connected) {
      return Promise.reject(new Error("Engine not connected."));
    }
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      p.reject(new Error(`Engine RPC timed out for method "${method}".`));
    }, 10 * 60_000);

    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, timeout });
    });
    proc.send({ id, type: "req", method, params: params ?? {}, ...(context ? { context } : {}) });
    return p;
  }

  function shutdown() {
    rejectAll(new Error("Engine shutdown."));
    killProcessTree(proc);
  }

  return { proc, call, shutdown };
}

function requireEngine() {
  if (!engine) throw new Error("Engine unavailable. Restart the IDE.");
  return engine;
}

function requireLocalLlmOrchestrator() {
  if (!localLlmOrchestrator) throw new Error("Local LLM runtime is unavailable. Restart the IDE.");
  return localLlmOrchestrator;
}

async function pickAvailablePort(preferredPort) {
  const shouldSkipHost = (err) => {
    const code = err && typeof err === "object" ? err.code : null;
    // Some environments may not have IPv6 loopback enabled; don't block dev boot on that.
    return code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL";
  };

  const tryListen = (port, host) =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.unref();
      s.on("error", reject);
      s.listen({ port, host }, () => {
        const addr = s.address();
        const chosen = addr && typeof addr === "object" ? addr.port : port;
        s.close(() => resolve(chosen));
      });
    });

  const isPortFree = async (port) => {
    // Next may bind on IPv6 (::) depending on flags/env, so we probe both loopbacks.
    const hosts = ["127.0.0.1", "::1"];
    for (const host of hosts) {
      try {
        await tryListen(port, host);
      } catch (err) {
        if (host === "::1" && shouldSkipHost(err)) continue;
        return false;
      }
    }
    return true;
  };

  if (await isPortFree(preferredPort)) return preferredPort;

  // Pick an ephemeral port and confirm it's usable on the loopback(s) we care about.
  for (let i = 0; i < 10; i += 1) {
    const candidate = await tryListen(0, "127.0.0.1");
    if (await isPortFree(candidate)) return candidate;
  }

  // Fall back to "any ephemeral port" even if IPv6 probing is inconclusive.
  return await tryListen(0, "127.0.0.1");
}

function materializeJudgeBuildContext({ backendDir, userDataDir }) {
  if (!app.isPackaged) return backendDir;

  const outDir = path.join(userDataDir, "judge-context");
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(outDir, { recursive: true });

  const files = [
    "Dockerfile.java-judge",
    "Dockerfile.python-judge",
    "Dockerfile.cpp-judge",
    "Dockerfile.sql-judge",
  ];

  for (const f of files) {
    fs.copyFileSync(path.join(backendDir, f), path.join(outDir, f));
  }

  // SQL judge Dockerfile copies this file from the build context.
  const sqlRunnerSrc = path.join(backendDir, "src", "languages", "sql", "judgeRunner.py");
  const sqlRunnerDest = path.join(outDir, "src", "languages", "sql", "judgeRunner.py");
  fs.mkdirSync(path.dirname(sqlRunnerDest), { recursive: true });
  fs.copyFileSync(sqlRunnerSrc, sqlRunnerDest);

  return outDir;
}

async function ensureNodeModules({ dir, label, env }) {
  const nm = path.join(dir, "node_modules");
  if (fs.existsSync(nm)) {
    console.log(`[ide] ${label}: node_modules present, skipping npm install`);
    return true;
  }

  console.log(`[ide] ${label}: installing npm dependencies...`);
  const child = spawn(getNpmBin(), ["install"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  wireLogs(`${label}:npm`, child);

  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    child.on("error", () => resolve(1));
  });

  return code === 0;
}

async function spawnAndWait(name, cmd, args, { cwd, env }) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  wireLogs(name, child);

  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(typeof c === "number" ? c : 1));
    child.on("error", () => resolve(1));
  });
  return code;
}

async function ensureJudgeImages({ dockerBin, backendDir, env }) {
  const rebuild = process.env.CODEMM_REBUILD_JUDGE === "1";
  const images = [
    { image: "codem-java-judge", dockerfile: "Dockerfile.java-judge" },
    { image: "codem-python-judge", dockerfile: "Dockerfile.python-judge" },
    { image: "codem-cpp-judge", dockerfile: "Dockerfile.cpp-judge" },
    { image: "codem-sql-judge", dockerfile: "Dockerfile.sql-judge" },
  ];

  for (const { image, dockerfile } of images) {
    if (rebuild) {
      console.log(`[ide] Rebuilding judge image: ${image}`);
      spawnSync(dockerBin, ["image", "rm", "-f", `${image}:latest`], { stdio: "ignore" });
    }

    const exists =
      spawnSync(dockerBin, ["image", "inspect", `${image}:latest`], { stdio: "ignore" }).status ===
      0;

    if (exists && !rebuild) {
      console.log(`[ide] Judge image found: ${image}`);
      continue;
    }

    console.log(`[ide] Building judge image: ${image} (from ${dockerfile})...`);
    const code = await spawnAndWait(
      `docker:${image}`,
      dockerBin,
      ["build", "--progress=plain", "-f", dockerfile, "-t", image, "."],
      { cwd: backendDir, env },
    );
    if (code !== 0) return false;
  }

  return true;
}

async function createWindowAndBoot() {
  const storage = configureElectronStoragePaths();
  console.log(`[ide] userDataDir=${storage.userDataDir}`);
  console.log(`[ide] cacheDir=${storage.cacheDir}`);

  // __dirname = apps/ide
  const repoRoot = path.resolve(__dirname, "..", "..");
  const backendDir =
    process.env.CODEMM_BACKEND_DIR || path.join(repoRoot, "apps", "backend");
  const frontendDir =
    process.env.CODEMM_FRONTEND_DIR || path.join(repoRoot, "apps", "frontend");

  console.log(`[ide] repoRoot=${repoRoot}`);
  console.log(`[ide] backendDir=${backendDir}`);
  console.log(`[ide] frontendDir=${frontendDir}`);

  // Dev ergonomics: default the workspace to the repo root (so `.codemm/` doesn't end up
  // in a parent folder like "Documents"). Developers can override with CODEMM_WORKSPACE_DIR,
  // or use the workspace chooser IPC later.
  if (!app.isPackaged && !process.env.CODEMM_WORKSPACE_DIR) {
    process.env.CODEMM_WORKSPACE_DIR = repoRoot;
  }

  const dockerBin = findDockerBinary();
  if (!dockerBin) {
    dialog.showErrorBox(
      "Docker Not Found",
      [
        "Codemm requires Docker for judging (/run and /submit).",
        "Install Docker Desktop and ensure `docker` is available in your PATH,",
        "or set DOCKER_PATH to the docker binary.",
      ].join("\n"),
    );
    app.quit();
    return;
  }
  console.log(`[ide] dockerBin=${dockerBin}`);

  console.log('[ide] Checking Docker ("docker info")...');
  const dockerCheck = await waitForDockerRunning({ dockerBin });
  if (!dockerCheck.ok) {
    dialog.showErrorBox(
      "Docker Not Running",
      [
        "Codemm requires Docker for judging.",
        "Start Docker Desktop, wait until it's running, then relaunch Codemm-Desktop.",
        "",
        `Details: ${dockerCheck.reason}`,
      ].join("\n"),
    );
    app.quit();
    return;
  }
  console.log("[ide] Docker is running");

  const workspaceResolution = await resolveWorkspace({ userDataDir: storage.userDataDir });
  if (!workspaceResolution.workspaceDir) {
    dialog.showErrorBox("No Workspace Selected", "Codemm-Desktop needs a workspace folder to store threads and runs.");
    app.quit();
    return;
  }

  const workspaceDir = workspaceResolution.workspaceDir;
  const workspaceDataDir = resolveWorkspaceDataDir({ userDataDir: storage.userDataDir, workspaceDir });
  const backendDbPath = path.join(workspaceDataDir, "codemm.db");
  currentWorkspace = { workspaceDir, workspaceDataDir, backendDbPath, userDataDir: storage.userDataDir };
  localLlmOrchestrator = new LocalLlmOrchestrator({
    userDataDir: storage.userDataDir,
    baseURL: OLLAMA_DEFAULT_URL,
    preferenceStore: {
      getLocalPreferredModel: () => {
        const llm = loadSecrets({ userDataDir: storage.userDataDir }).llm;
        return llm && String(llm.provider || "").toLowerCase() === "ollama" ? llm.model ?? null : null;
      },
      setLocalPreferredModel: (model) => {
        const current = loadSecrets({ userDataDir: storage.userDataDir }).llm;
        if (!current) return;
        if (String(current.provider || "").toLowerCase() !== "ollama") return;
        saveSecrets({
          userDataDir: storage.userDataDir,
          provider: "ollama",
          apiKey: null,
          model,
          baseURL: current.baseURL || OLLAMA_DEFAULT_URL,
        });
      },
      activateLocalProvider: ({ model }) => {
        saveSecrets({
          userDataDir: storage.userDataDir,
          provider: "ollama",
          apiKey: null,
          model: model || null,
          baseURL: OLLAMA_DEFAULT_URL,
        });
      },
    },
  });

  console.log(`[ide] workspaceDir=${workspaceDir}`);
  console.log(`[ide] workspaceDataDir=${workspaceDataDir}`);
  console.log(`[ide] backendDbPath=${backendDbPath}`);

  if (!ipcWired) {
    ipcWired = true;

    const reqString = (v, name) => {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) throw new Error(`${name} is required.`);
      return s;
    };
    const ROUTE_ROLES = ["dialogue", "skeleton", "tests", "reference", "repair", "edit"];
    const LOCAL_PROFILE_MODELS = {
      fast_local: "qwen2.5-coder:1.5b",
      balanced_local: "qwen2.5-coder:7b",
      strong_local: "qwen2.5-coder:14b",
    };
    const normalizeRoutingProfile = (raw) => {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value === "fast_local" || value === "balanced_local" || value === "strong_local" || value === "custom") {
        return value;
      }
      return "auto";
    };
    const inferCapability = (provider, model) => {
      const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
      if (!normalized) return provider === "ollama" ? "weak" : "strong";
      if (provider !== "ollama") return "strong";
      const billionMatch = /(\d+(?:\.\d+)?)b\b/.exec(normalized);
      const size = billionMatch?.[1] ? Number(billionMatch[1]) : Number.NaN;
      if (Number.isFinite(size)) {
        if (size <= 3) return "weak";
        if (size < 12) return "balanced";
        return "strong";
      }
      return "balanced";
    };
    const sanitizeRoleModels = (raw) => {
      const out = {};
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
      for (const role of ROUTE_ROLES) {
        const value = typeof raw[role] === "string" ? raw[role].trim() : "";
        if (value) out[role] = value;
      }
      return out;
    };
    const buildRemoteRoutePlan = (llm) => {
      if (!llm || !llm.provider) return null;
      const provider = String(llm.provider).trim().toLowerCase();
      if (provider !== "openai" && provider !== "anthropic" && provider !== "gemini") return null;
      if (!(llm.apiKey && String(llm.apiKey).trim())) {
        throw new Error(`Missing API key for ${provider}.`);
      }
      const normalizedProfile = normalizeRoutingProfile(llm.routingProfile);
      const roleModels = sanitizeRoleModels(llm.roleModels);
      const defaultModel = typeof llm.model === "string" && llm.model.trim() ? llm.model.trim() : null;
      const modelsByRole = {};
      for (const role of ROUTE_ROLES) {
        const model = normalizedProfile === "custom" ? roleModels[role] || defaultModel : defaultModel;
        if (!model) continue;
        modelsByRole[role] = {
          model,
          capability: inferCapability(provider, model),
        };
      }
      return {
        provider,
        apiKey: llm.apiKey,
        ...(defaultModel ? { defaultModel } : {}),
        ...(llm.baseURL ? { baseURL: llm.baseURL } : {}),
        revision: `remote-${provider}`,
        routingProfile: normalizedProfile,
        modelsByRole,
      };
    };
    const buildLocalRoutePlan = (llm) => {
      const normalizedProfile = normalizeRoutingProfile(llm?.routingProfile);
      const storedModel = typeof llm?.model === "string" && llm.model.trim() ? llm.model.trim() : null;
      const roleModels = sanitizeRoleModels(llm?.roleModels);
      const profileModel = normalizedProfile === "auto" ? storedModel : LOCAL_PROFILE_MODELS[normalizedProfile] || storedModel;
      const defaultModel = profileModel || storedModel || requireLocalLlmOrchestrator().getStatus()?.runtime?.activeModel || "qwen2.5-coder:1.5b";
      const modelsByRole = {};
      for (const role of ROUTE_ROLES) {
        const model = normalizedProfile === "custom" ? roleModels[role] || defaultModel : defaultModel;
        modelsByRole[role] = {
          model,
          capability: inferCapability("ollama", model),
        };
      }
      return {
        provider: "ollama",
        baseURL: llm?.baseURL || OLLAMA_DEFAULT_URL,
        revision: `local-${normalizedProfile}`,
        readiness: "READY",
        defaultModel,
        routingProfile: normalizedProfile,
        modelsByRole,
      };
    };
    const buildRoutePlan = (llm) => {
      if (!llm || !llm.provider) return null;
      const provider = String(llm.provider).trim().toLowerCase();
      if (provider === "ollama") return buildLocalRoutePlan(llm);
      return buildRemoteRoutePlan(llm);
    };

    const resolveLlmRoutePlanForMethod = async (method, opts = {}) => {
      const llm = loadSecrets({ userDataDir: storage.userDataDir }).llm;
      if (!llm || !llm.provider) {
        throw new Error("No LLM configured.");
      }

      const provider = String(llm.provider).trim().toLowerCase();
      if (provider === "ollama") {
        const routePlan = buildLocalRoutePlan(llm);
        const uniqueModels = Array.from(
          new Set(
            Object.values(routePlan.modelsByRole || {})
              .map((route) => (route && typeof route.model === "string" ? route.model.trim() : ""))
              .filter(Boolean)
          )
        );
        const leases = [];
        for (const model of uniqueModels) {
          const lease = await requireLocalLlmOrchestrator().acquireLease({
            reason: `${method}:${model}`,
            useCase: opts.useCase || "general",
            forcedModel: model,
          });
          leases.push(lease);
        }
        const firstLease = leases[0] || null;
        return {
          routePlan: {
            ...routePlan,
            ...(firstLease?.baseURL ? { baseURL: firstLease.baseURL } : {}),
            ...(firstLease?.revision ? { revision: firstLease.revision } : {}),
          },
          release: async () => {
            for (const lease of leases) {
              await requireLocalLlmOrchestrator().releaseLease(lease.leaseId);
            }
          },
        };
      }

      const routePlan = buildRemoteRoutePlan(llm);
      if (!routePlan) {
        throw new Error(`Unsupported provider "${provider}".`);
      }
      return { routePlan, release: async () => {} };
    };

    const engineCall = async (method, params, opts = {}) => {
      if (!opts.llm) return requireEngine().call(method, params);
      const { routePlan, release } = await resolveLlmRoutePlanForMethod(method, opts);
      try {
        return await requireEngine().call(method, params, { llmRoutePlan: routePlan });
      } catch (err) {
        if (routePlan?.provider === "ollama") {
          try {
            requireLocalLlmOrchestrator().markDegraded(err);
          } catch {
            // ignore degradation bookkeeping failures
          }
        }
        throw err;
      } finally {
        await release();
      }
    };

    registerWorkspaceIpc({
      tryRegisterIpcHandler,
      storage,
      getCurrentWorkspace: () => currentWorkspace,
      setCurrentWorkspace: (nextWorkspace) => {
        currentWorkspace = nextWorkspace;
      },
      resolveWorkspace,
      resolveWorkspaceDataDir,
      dialog,
    });

    registerLlmIpc({
      tryRegisterIpcHandler,
      validate,
      storage,
      loadSecrets,
      saveSecrets,
      clearSecrets,
      dialog,
      buildRoutePlan,
      requireLocalLlmOrchestrator,
      sanitizeRoleModels,
      OLLAMA_DEFAULT_URL,
      getMainWindow: () => mainWindow,
    });

    registerThreadsIpc({
      tryRegisterIpcHandler,
      validate,
      reqString,
      engineCall,
    });

    registerActivitiesIpc({
      tryRegisterIpcHandler,
      validate,
      reqString,
      engineCall,
    });

    registerJudgeIpc({
      tryRegisterIpcHandler,
      validate,
      engineCall,
    });
  }

  const frontendUrlHint = `http://127.0.0.1:${DEFAULT_FRONTEND_PORT}`;
  console.log(`[ide] frontendUrlHint=${frontendUrlHint}`);

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    // Avoid showing a dev-looking splash immediately on app launch.
    // We keep the window hidden unless boot takes "long enough" to warrant showing a minimal launch screen.
    show: false,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    mainWindow = null;
  });

  // Deny all permission requests by default (camera/mic/notifications/etc).
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  } catch {
    // ignore
  }

  // Hard block popups; if the UI needs external links, we can explicitly open them with `shell.openExternal`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // If this is an external URL, open it in the user's browser.
    if (url && /^https?:\/\//.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // Prevent navigations away from the expected local frontend origin.
  // The allowed origin is set once the frontend port is chosen.
  let allowedFrontendOrigin = null;
  const maybeBlockNavigation = (e, url) => {
    try {
      if (typeof url !== "string" || !url) return;
      if (url.startsWith("data:text/html")) return;
      if (!allowedFrontendOrigin) return;
      const u = new URL(url);
      if (u.origin === allowedFrontendOrigin) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      e.preventDefault();
    }
  };
  win.webContents.on("will-navigate", maybeBlockNavigation);
  win.webContents.on("will-redirect", maybeBlockNavigation);

  let frontendLoaded = false;
  const shouldShowSplash = (() => {
    const raw = process.env.CODEMM_SHOW_STARTUP_SPLASH;
    if (raw == null) return true;
    const s = String(raw).trim().toLowerCase();
    if (s === "0" || s === "false" || s === "no") return false;
    return true;
  })();

  // If boot is slow (first launch / docker images / missing deps), show a minimal launch screen.
  // If boot is fast, we avoid showing any intermediate UI at all.
  const SPLASH_DELAY_MS = 1200;
  const splashTimer = setTimeout(() => {
    try {
      if (!shouldShowSplash) return;
      if (frontendLoaded) return;
      if (win.isDestroyed()) return;
      if (win.isVisible()) return;
      win.show();
    } catch {
      // ignore
    }
  }, SPLASH_DELAY_MS);

  const splashUpdate = (patch) => {
    try {
      const payload = JSON.stringify(patch).replace(/</g, "\\u003c");
      win.webContents.executeJavaScript(`window.__codemmSplashUpdate && window.__codemmSplashUpdate(${payload});`, true);
    } catch {
      // ignore
    }
  };

  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Codemm-Desktop</title>
          <style>
            html, body { height: 100%; margin: 0; }
            body {
              font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
              background: radial-gradient(1200px 800px at 20% 10%, #172554 0%, #0b1220 55%, #050814 100%);
              color: #e2e8f0;
            }
            .bg {
              position: fixed;
              inset: 0;
              pointer-events: none;
              overflow: hidden;
            }
            .orb {
              position: absolute;
              width: 680px;
              height: 680px;
              border-radius: 999px;
              filter: blur(70px);
              opacity: 0.42;
            }
            .orb.one { left: -220px; top: -260px; background: rgba(56, 189, 248, 0.30); }
            .orb.two { right: -260px; bottom: -340px; background: rgba(99, 102, 241, 0.22); }
            .shell {
              position: relative;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
            }
            .topbar {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 18px 22px;
              border-bottom: 1px solid rgba(148, 163, 184, 0.14);
              background: rgba(2, 6, 23, 0.30);
              backdrop-filter: blur(10px);
            }
            .brandRow { display: flex; align-items: center; gap: 10px; }
            .logoMark {
              width: 10px;
              height: 10px;
              border-radius: 999px;
              background: rgba(56, 189, 248, 0.95);
              box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12);
            }
            .brand {
              font-size: 18px;
              font-weight: 800;
              letter-spacing: 0.01em;
            }
            .pillRow { display: flex; align-items: center; gap: 10px; }
            .pill {
              height: 34px;
              padding: 0 14px;
              border-radius: 999px;
              border: 1px solid rgba(148, 163, 184, 0.14);
              background: rgba(15, 23, 42, 0.35);
            }
            .pill.wide { width: 108px; }
            .pill.narrow { width: 86px; }
            .pill.icon { width: 34px; padding: 0; }
            .main {
              flex: 1;
              display: grid;
              place-items: center;
              padding: 36px 22px 44px 22px;
            }
            .card {
              width: min(860px, calc(100vw - 56px));
              border: 1px solid rgba(148, 163, 184, 0.16);
              background: rgba(2, 6, 23, 0.36);
              border-radius: 18px;
              padding: 22px 22px;
              box-shadow: 0 24px 80px rgba(0,0,0,0.42);
            }
            .headline { font-size: 14px; font-weight: 650; letter-spacing: 0.02em; margin: 0; }
            .sub {
              margin-top: 10px;
              color: rgba(226, 232, 240, 0.74);
              font-size: 13px;
              line-height: 1.5;
            }
            .progress { margin-top: 14px; display: grid; gap: 10px; }
            .bar {
              height: 10px;
              border-radius: 999px;
              background: rgba(148, 163, 184, 0.16);
              overflow: hidden;
              position: relative;
            }
            .fill {
              height: 100%;
              width: 0%;
              border-radius: 999px;
              background: linear-gradient(90deg, rgba(56, 189, 248, 0.95), rgba(99, 102, 241, 0.85));
              transition: width 240ms ease;
            }
            .fill.indeterminate {
              width: 100%;
              background: linear-gradient(
                90deg,
                rgba(56, 189, 248, 0.0),
                rgba(56, 189, 248, 0.65),
                rgba(99, 102, 241, 0.35),
                rgba(56, 189, 248, 0.0)
              );
              background-size: 180% 100%;
              animation: shimmer 1.1s ease-in-out infinite;
            }
            @keyframes shimmer { 0% { background-position: 0% 0%; } 100% { background-position: 180% 0%; } }
            .meta {
              display: flex;
              justify-content: space-between;
              gap: 12px;
              color: rgba(226, 232, 240, 0.58);
              font-size: 12px;
              font-variant-numeric: tabular-nums;
            }
            .hint {
              margin-top: 12px;
              color: rgba(226, 232, 240, 0.60);
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="bg" aria-hidden="true">
            <div class="orb one"></div>
            <div class="orb two"></div>
          </div>
          <div class="shell">
            <div class="topbar">
              <div class="brandRow">
                <div class="logoMark"></div>
                <div class="brand">Codemm</div>
              </div>
              <div class="pillRow" aria-hidden="true">
                <div class="pill wide"></div>
                <div class="pill narrow"></div>
                <div class="pill narrow"></div>
                <div class="pill icon"></div>
              </div>
            </div>
            <div class="main">
              <div class="card">
                <p class="headline" id="headline">Launching…</p>
                <div class="sub" id="status">Starting the engine and preparing the interface.</div>
                <div class="progress" aria-label="Startup progress">
                  <div class="bar" aria-hidden="true"><div class="fill" id="fill"></div></div>
                  <div class="meta" aria-hidden="true">
                    <div id="step">Preparing…</div>
                    <div id="pct">0%</div>
                  </div>
                </div>
                <div class="hint">First launch may take longer while Docker images are prepared.</div>
              </div>
            </div>
          </div>
          <script>
            (function () {
              function clamp(n) {
                var x = Number(n);
                if (!isFinite(x)) return 0;
                return Math.max(0, Math.min(100, Math.round(x)));
              }

              var state = {
                headline: "Launching…",
                status: "Starting the engine and preparing the interface.",
                step: "Preparing…",
                pct: 0,
                indeterminate: false,
              };

              function setText(id, text) {
                var el = document.getElementById(id);
                if (!el) return;
                el.textContent = String(text || "");
              }

              function setBar(id, pct, indeterminate) {
                var el = document.getElementById(id);
                if (!el) return;
                if (indeterminate) {
                  el.classList.add("indeterminate");
                  el.style.width = "100%";
                  return;
                }
                el.classList.remove("indeterminate");
                el.style.width = clamp(pct) + "%";
              }

              function render() {
                setText("headline", state.headline);
                setText("status", state.status);
                setText("step", state.step);
                setText("pct", clamp(state.pct) + "%");
                setBar("fill", state.pct, state.indeterminate);
              }

              window.__codemmSplashUpdate = function (patch) {
                try {
                  if (patch && typeof patch === "object") {
                    if (typeof patch.headline === "string") state.headline = patch.headline;
                    if (typeof patch.status === "string") state.status = patch.status;
                    if (typeof patch.step === "string") state.step = patch.step;
                    if (typeof patch.pct !== "undefined") state.pct = clamp(patch.pct);
                    if (typeof patch.indeterminate === "boolean") state.indeterminate = patch.indeterminate;

                    // Back-compat with earlier patch shapes.
                    if (typeof patch.sub === "string") state.status = patch.sub;
                    if (typeof patch.overall !== "undefined") state.pct = clamp(patch.overall);
                    if (patch.deps && typeof patch.deps === "object" && typeof patch.deps.indeterminate === "boolean") {
                      state.indeterminate = patch.deps.indeterminate;
                    }
                    if (patch.judge && typeof patch.judge === "object" && typeof patch.judge.indeterminate === "boolean") {
                      state.indeterminate = patch.judge.indeterminate;
                    }
                    if (patch.app && typeof patch.app === "object" && typeof patch.app.indeterminate === "boolean") {
                      state.indeterminate = patch.app.indeterminate;
                    }
                  }
                } catch (e) {}
                render();
              };

              render();
            })();
          </script>
        </body>
      </html>
    `)}`,
  );

  let backendProc = null;
  let frontendProc = null;

  const baseEnv = { ...process.env };
  // Improve odds of finding docker from a GUI-launched app (PATH can be minimal on macOS).
  baseEnv.DOCKER_PATH = dockerBin;
  if (dockerBin !== "docker") {
    const dockerDir = path.dirname(dockerBin);
    prependToPath(baseEnv, dockerDir);
  }

  // Ensure monorepo dependencies exist (npm workspaces).
  {
    if (!app.isPackaged) {
      splashUpdate({
        headline: "Launching…",
        status: "Checking dependencies…",
        step: "Dependencies",
        pct: 5,
        indeterminate: true,
      });
      const ok = await ensureNodeModules({ dir: repoRoot, label: "repo", env: baseEnv });
      if (!ok) {
        dialog.showErrorBox(
          "Dependencies Failed",
          `Failed to install npm dependencies in ${repoRoot}. Check terminal logs.`,
        );
        app.quit();
        return;
      }
      splashUpdate({ pct: 12, indeterminate: false });
    }
  }

  // Ensure Docker judge images exist (Codemm compiles/runs in Docker).
  {
    console.log("[ide] Ensuring judge Docker images...");
    splashUpdate({
      status: "Preparing Docker judge…",
      step: "Docker judge",
      pct: 18,
      indeterminate: true,
    });
    const judgeContextDir = materializeJudgeBuildContext({ backendDir, userDataDir: storage.userDataDir });
    const ok = await ensureJudgeImages({ dockerBin, backendDir: judgeContextDir, env: baseEnv });
    if (!ok) {
      dialog.showErrorBox(
        "Judge Images Failed",
        "Failed to build judge Docker images. Check terminal logs and ensure Docker Desktop has enough resources.",
      );
      app.quit();
      return;
    }
    splashUpdate({ pct: 62, indeterminate: false });
  }

  // Start engine (workspace).
  console.log("[ide] Starting engine (IPC)...");
  splashUpdate({
    status: "Starting engine…",
    step: "Engine",
    pct: 68,
    indeterminate: true,
  });
  if (!app.isPackaged) {
    console.log(`[ide] Engine nodeBin=${resolveNodeBin()}`);
  }
  const engineDbPath =
    typeof baseEnv.CODEMM_DB_PATH === "string" && baseEnv.CODEMM_DB_PATH.trim()
      ? baseEnv.CODEMM_DB_PATH.trim()
      : currentWorkspace.backendDbPath;

  backendProc = startEngineIpc({
    backendDir,
    env: {
      ...baseEnv,
      ...(app.isPackaged ? { NODE_ENV: "production", CODEMM_ENGINE_USE_DIST: "1" } : {}),
      CODEMM_DB_PATH: engineDbPath,
      CODEMM_WORKSPACE_DIR: currentWorkspace.workspaceDir,
    },
    onEvent: (evt) => {
      if (!evt || typeof evt.topic !== "string") return;
      if (evt.topic === "threads.generation") {
        try {
          mainWindow?.webContents?.send("codemm:threads:generationEvent", evt.payload);
        } catch {
          // ignore
        }
      }
    },
  });
  engine = backendProc;

  backendProc.proc.on("error", (err) => {
    dialog.showErrorBox("Engine Failed To Start", String(err?.message || err));
    app.quit();
  });

  backendProc.proc.on("exit", (code) => {
    if (!app.isQuiting) {
      dialog.showErrorBox(
        "Engine Exited",
        `Codemm engine exited unexpectedly (code=${code ?? "unknown"}). Check terminal logs.`,
      );
      app.quit();
    }
  });

  // Quick connectivity check (no ports/health endpoints).
  try {
    await backendProc.call("engine.ping", {});
    console.log("[ide] Engine is ready (IPC)");
    splashUpdate({ pct: 78, indeterminate: false });
  } catch (err) {
    dialog.showErrorBox("Engine Failed To Start", String(err?.message || err));
    backendProc.shutdown();
    app.quit();
    return;
  }

  const preferredFrontendPort = DEFAULT_FRONTEND_PORT;
  const frontendPort = await pickAvailablePort(preferredFrontendPort);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const frontendToken = crypto.randomUUID();
  allowedFrontendOrigin = new URL(frontendUrl).origin;
  if (frontendPort !== preferredFrontendPort) {
    console.warn(`[ide] Frontend port ${preferredFrontendPort} is in use; using ${frontendPort} instead.`);
  }

  // Start frontend.
  const standaloneServer = path.join(frontendDir, ".next", "standalone", "server.js");
  const useStandalone = app.isPackaged || process.env.CODEMM_FRONTEND_MODE === "standalone";
  if (useStandalone) {
    if (!fs.existsSync(standaloneServer)) {
      dialog.showErrorBox(
        "Frontend Build Missing",
        [
          "Could not find the built Next standalone server.",
          "",
          `Expected: ${standaloneServer}`,
          "",
          "In dev, run: npm run build:frontend",
        ].join("\n"),
      );
      backendProc.shutdown();
      app.quit();
      return;
    }
    console.log(`[ide] Starting frontend (standalone) on ${frontendUrl}...`);
    const spawnFrontend = app.isPackaged ? spawnNodeWithElectron : spawnSystemNode;
    if (!app.isPackaged) {
      console.log(`[ide] Frontend nodeBin=${resolveNodeBin()}`);
    }
    frontendProc = spawnFrontend(standaloneServer, [], {
      cwd: path.dirname(standaloneServer),
      env: {
        ...baseEnv,
        PORT: String(frontendPort),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        CODEMM_FRONTEND_TOKEN: frontendToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    frontendProc.unref();
  } else {
    console.log(`[ide] Starting frontend (dev) on ${frontendUrl}...`);
    const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
    if (!fs.existsSync(nextBin)) {
      dialog.showErrorBox(
        "Frontend Dependencies Missing",
        [
          "Could not find the Next.js CLI in node_modules.",
          "",
          `Expected: ${nextBin}`,
          "",
          "Run: npm install",
        ].join("\n"),
      );
      backendProc.shutdown();
      app.quit();
      return;
    }
    frontendProc = spawnSystemNode(
      nextBin,
      ["dev", "-p", String(frontendPort), "-H", "127.0.0.1"],
      {
        cwd: frontendDir,
        env: {
          ...baseEnv,
          PORT: String(frontendPort),
          HOSTNAME: "127.0.0.1",
          NEXT_TELEMETRY_DISABLED: "1",
          CODEMM_FRONTEND_TOKEN: frontendToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    frontendProc.unref();
  }
  wireLogs("frontend", frontendProc);
  frontendProc.on("error", (err) => {
    dialog.showErrorBox("Frontend Failed To Start", String(err?.message || err));
    app.quit();
  });

  frontendProc.on("exit", (code) => {
    if (!app.isQuiting) {
      dialog.showErrorBox(
        "Frontend Exited",
        `Codemm frontend exited unexpectedly (code=${code ?? "unknown"}). Check terminal logs.`,
      );
      app.quit();
    }
  });

  splashUpdate({ status: "Starting UI…", step: "UI", pct: 86, indeterminate: true });
  console.log(`[ide] Waiting for frontend health: ${frontendUrl}/codemm/health`);
  const frontendReady = await waitForFrontendReady(frontendUrl, { token: frontendToken, timeoutMs: 180_000 });
  if (!frontendReady) {
    dialog.showErrorBox(
      "Frontend Failed To Start",
      `Frontend did not become ready at ${frontendUrl} within timeout.`,
    );
    killProcessTree(frontendProc);
    try {
      backendProc?.shutdown?.();
    } catch {
      killProcessTree(backendProc?.proc);
    }
    app.quit();
    return;
  }

  console.log("[ide] Frontend is ready; loading UI...");
  frontendLoaded = true;
  clearTimeout(splashTimer);
  splashUpdate({ status: "Finalizing…", step: "Finishing up", pct: 98, indeterminate: true });
  await win.loadURL(frontendUrl);
  // Show the window once the real UI is ready to paint.
  try {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  } catch {
    // ignore
  }
  splashUpdate({ pct: 100, indeterminate: false });

  const cleanup = () => {
    killProcessTree(frontendProc);
    try {
      backendProc?.shutdown?.();
    } catch {
      killProcessTree(backendProc?.proc);
    }
  };

  app.on("before-quit", () => {
    app.isQuiting = true;
    cleanup();
  });
}

process.on("uncaughtException", (err) => {
  // Best-effort: surface fatal errors if Electron started from a GUI context.
  try {
    dialog.showErrorBox("Codemm-Desktop Crashed", redactSecrets(String(err?.stack || err?.message || err)));
  } catch {
    // ignore
  }
  // eslint-disable-next-line no-console
  console.error(redactSecrets(String(err?.stack || err?.message || err)));
});

process.on("unhandledRejection", (err) => {
  try {
    dialog.showErrorBox("Codemm-Desktop Error", redactSecrets(String(err?.stack || err?.message || err)));
  } catch {
    // ignore
  }
  // eslint-disable-next-line no-console
  console.error(redactSecrets(String(err?.stack || err?.message || err)));
});

app.whenReady().then(() => {
  console.log("[ide] Electron ready. Booting engine + frontend...");
  return createWindowAndBoot();
});

app.on("window-all-closed", () => {
  // On macOS, typical apps stay open without windows; for an IDE we quit.
  app.quit();
});

app.on("activate", () => {
  // macOS: clicking the dock icon should bring a window back.
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  createWindowAndBoot().catch((err) => {
    try {
      dialog.showErrorBox("Failed To Launch", String(err?.stack || err?.message || err));
    } catch {
      // ignore
    }
  });
});
