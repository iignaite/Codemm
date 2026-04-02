const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { LocalLlmError, asLocalLlmError } = require("./errors");
const { commandExists, downloadToFile, existsExecutable, httpGetJson, runCommand, sleep } = require("./utils");

const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

function getMacAppBinaryCandidates(appRoot) {
  return [
    path.join(appRoot, "Contents", "Resources", "ollama"),
    path.join(appRoot, "Contents", "MacOS", "Ollama"),
  ];
}

function getMacAppRoot(binaryPath) {
  if (typeof binaryPath !== "string") return null;
  const marker = `${path.sep}Contents${path.sep}`;
  const idx = binaryPath.indexOf(marker);
  if (idx < 0) return null;
  const root = binaryPath.slice(0, idx);
  return root.endsWith(".app") ? root : null;
}

function tail(text, limit = 1200) {
  const value = String(text || "");
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function findOllamaBinary(explicitPath) {
  if (explicitPath && existsExecutable(explicitPath)) return explicitPath;
  if (process.env.OLLAMA_PATH && existsExecutable(process.env.OLLAMA_PATH)) return process.env.OLLAMA_PATH;

  const candidates = [];
  if (commandExists("ollama", ["--version"])) candidates.push("ollama");

  if (process.platform === "darwin") {
    candidates.push(
      "/usr/local/bin/ollama",
      "/opt/homebrew/bin/ollama",
      ...getMacAppBinaryCandidates("/Applications/Ollama.app"),
      ...getMacAppBinaryCandidates(path.join(os.homedir(), "Applications", "Ollama.app"))
    );
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      "C:\\Program Files\\Ollama\\ollama.exe"
    );
  } else {
    candidates.push("/usr/bin/ollama", "/usr/local/bin/ollama");
  }

  for (const candidate of candidates) {
    if (candidate === "ollama") return candidate;
    if (existsExecutable(candidate)) return candidate;
  }
  return null;
}

async function getVersion(baseURL) {
  return httpGetJson(`${String(baseURL || OLLAMA_DEFAULT_URL).replace(/\/+$/, "")}/api/version`, { timeoutMs: 1_500 });
}

function resolveInstallArtifactUrl() {
  if (process.platform === "darwin") {
    return process.env.CODEMM_OLLAMA_INSTALL_URL_DARWIN || "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz";
  }
  if (process.platform === "win32") {
    return process.env.CODEMM_OLLAMA_INSTALL_URL_WINDOWS || "https://ollama.com/download/OllamaSetup.exe";
  }
  if (process.platform === "linux") {
    return process.env.CODEMM_OLLAMA_INSTALL_URL_LINUX || "https://ollama.com/install.sh";
  }
  return null;
}

function getManagedInstallPaths(userDataDir) {
  const rootDir = path.join(userDataDir, "local-llm-runtime");
  const downloadsDir = path.join(rootDir, "downloads");

  if (process.platform === "darwin") {
    return {
      rootDir,
      downloadsDir,
      archivePath: path.join(downloadsDir, "ollama-darwin.tgz"),
      managedBinaryPath: path.join(rootDir, "bin", "ollama"),
    };
  }
  if (process.platform === "win32") {
    return {
      rootDir,
      downloadsDir,
      archivePath: path.join(downloadsDir, "OllamaSetup.exe"),
      managedBinaryPath: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe"),
    };
  }
  return {
    rootDir,
    downloadsDir,
    archivePath: path.join(downloadsDir, "install-ollama.sh"),
    managedBinaryPath: findOllamaBinary(null),
  };
}

async function installOllama({ userDataDir, onProgress }) {
  const installUrl = resolveInstallArtifactUrl();
  if (!installUrl) {
    throw new LocalLlmError("INSTALL_FAILED", `Unsupported platform for automated Ollama install: ${process.platform}`, {
      stage: "INSTALLING",
      recoverable: false,
    });
  }

  const paths = getManagedInstallPaths(userDataDir);
  fs.mkdirSync(paths.downloadsDir, { recursive: true });

  onProgress?.({ message: "Downloading Ollama runtime…" });
  await downloadToFile(installUrl, paths.archivePath, {
    timeoutMs: 30 * 60_000,
    onProgress: ({ downloaded, total }) => onProgress?.({ message: "Downloading Ollama runtime…", downloaded, total }),
  });

  if (process.platform === "darwin") {
    const binDir = path.dirname(paths.managedBinaryPath);
    fs.mkdirSync(binDir, { recursive: true });
    const unpack = await runCommand("tar", ["-xzf", paths.archivePath, "-C", binDir], { timeoutMs: 10 * 60_000 });
    if (unpack.code !== 0) {
      throw new LocalLlmError("INSTALL_FAILED", "Failed to unpack Ollama CLI archive on macOS.", {
        stage: "INSTALLING",
        detail: unpack.stderr || unpack.stdout,
      });
    }
    const chmod = await runCommand("chmod", ["+x", paths.managedBinaryPath], { timeoutMs: 30_000 });
    if (chmod.code !== 0) {
      throw new LocalLlmError("INSTALL_FAILED", "Failed to mark Ollama CLI executable on macOS.", {
        stage: "INSTALLING",
        detail: chmod.stderr || chmod.stdout,
      });
    }
  } else if (process.platform === "win32") {
    const install = await runCommand(paths.archivePath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], {
      timeoutMs: 20 * 60_000,
    });
    if (install.code !== 0) {
      throw new LocalLlmError("INSTALL_FAILED", "Silent Ollama installer failed on Windows.", {
        stage: "INSTALLING",
        detail: install.stderr || install.stdout,
      });
    }
  } else if (process.platform === "linux") {
    const chmod = await runCommand("chmod", ["+x", paths.archivePath], { timeoutMs: 30_000 });
    if (chmod.code !== 0) {
      throw new LocalLlmError("INSTALL_FAILED", "Failed to mark Ollama install script executable.", {
        stage: "INSTALLING",
        detail: chmod.stderr || chmod.stdout,
      });
    }
    const install = await runCommand("sh", [paths.archivePath], { timeoutMs: 20 * 60_000 });
    if (install.code !== 0) {
      throw new LocalLlmError("INSTALL_FAILED", "Ollama install script failed on Linux.", {
        stage: "INSTALLING",
        detail: install.stderr || install.stdout,
      });
    }
  }

  const installedBinary = findOllamaBinary(paths.managedBinaryPath);
  if (!installedBinary) {
    throw new LocalLlmError("INSTALL_FAILED", "Ollama installation finished but no executable was detected.", {
      stage: "INSTALLING",
      detail: paths.managedBinaryPath,
    });
  }

  return { binaryPath: installedBinary };
}

async function detectInstallation({ persistedBinaryPath, baseURL }) {
  const binaryPath = findOllamaBinary(persistedBinaryPath);
  let version = null;
  let running = false;

  if (binaryPath) {
    try {
      const result = await runCommand(binaryPath, ["--version"], { timeoutMs: 10_000 });
      if (result.code === 0) version = (result.stdout || result.stderr || "").trim() || null;
    } catch {
      // ignore
    }
  }

  try {
    await getVersion(baseURL);
    running = true;
  } catch {
    running = false;
  }

  return {
    installed: Boolean(binaryPath),
    binaryPath,
    version,
    running,
  };
}

async function startServer({ binaryPath, baseURL, onProgress }) {
  const normalizedBaseUrl = String(baseURL || OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  const attempts = [{ cmd: binaryPath, args: ["serve"], label: "cli", allowSuccessExitBeforeReady: false }];

  if (process.platform === "darwin") {
    const appRoot = getMacAppRoot(binaryPath);
    if (appRoot) {
      const appExecutable = path.join(appRoot, "Contents", "MacOS", "Ollama");
      if (existsExecutable(appExecutable) && appExecutable !== binaryPath) {
        attempts.push({ cmd: appExecutable, args: ["serve"], label: "app-executable", allowSuccessExitBeforeReady: false });
      }
      attempts.push({ cmd: "open", args: ["-a", appRoot], label: "open-app", allowSuccessExitBeforeReady: true });
    }
  }

  let lastFailure = null;
  for (const attempt of attempts) {
    onProgress?.({ message: `Starting Ollama runtime (${attempt.label})…` });

    const child = spawn(attempt.cmd, attempt.args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let spawnError = null;

    child.stdout?.on("data", (buf) => {
      stdout += String(buf || "");
    });
    child.stderr?.on("data", (buf) => {
      stderr += String(buf || "");
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) {
        break;
      }

      try {
        await getVersion(normalizedBaseUrl);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        return { pid: child.pid, baseURL: normalizedBaseUrl };
      } catch {
        if (
          (exitCode !== null && (!attempt.allowSuccessExitBeforeReady || exitCode !== 0)) ||
          exitSignal !== null
        ) {
          break;
        }
        await sleep(500);
      }
    }

    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();

    lastFailure = new LocalLlmError(
      "SERVER_START_FAILED",
      spawnError
        ? `Failed to launch Ollama using ${attempt.label}.`
        : (exitCode !== null && (!attempt.allowSuccessExitBeforeReady || exitCode !== 0)) || exitSignal !== null
          ? `Ollama exited before becoming ready using ${attempt.label}.`
          : `Timed out waiting for Ollama to start using ${attempt.label}.`,
      {
        stage: "STARTING",
        detail: {
          baseURL: normalizedBaseUrl,
          attempt: attempt.label,
          cmd: attempt.cmd,
          args: attempt.args,
          exitCode,
          exitSignal,
          stdout: tail(stdout),
          stderr: tail(stderr),
          spawnError: spawnError ? String(spawnError.message || spawnError) : null,
        },
      }
    );
  }

  throw lastFailure || new LocalLlmError("SERVER_START_FAILED", "Timed out waiting for Ollama to start.", {
    stage: "STARTING",
    detail: normalizedBaseUrl,
  });
}

async function listModels({ baseURL }) {
  const normalizedBaseUrl = String(baseURL || OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  const tags = await httpGetJson(`${normalizedBaseUrl}/api/tags`, { timeoutMs: 4_000 });
  return Array.isArray(tags?.models)
    ? tags.models.map((model) => (model && typeof model.name === "string" ? model.name : null)).filter(Boolean)
    : [];
}

async function pullModel({ binaryPath, model, onProgress }) {
  try {
    const result = await runCommand(binaryPath, ["pull", model], {
      timeoutMs: 45 * 60_000,
      onStdout: (text) => onProgress?.({ message: text.trim(), stream: "stdout" }),
      onStderr: (text) => onProgress?.({ message: text.trim(), stream: "stderr" }),
    });
    if (result.code !== 0) {
      throw new LocalLlmError("MODEL_PULL_FAILED", `Failed to pull Ollama model "${model}".`, {
        stage: "PULLING_MODEL",
        detail: result.stderr || result.stdout,
      });
    }
  } catch (err) {
    throw asLocalLlmError(err, {
      code: "MODEL_PULL_FAILED",
      stage: "PULLING_MODEL",
      message: `Failed to pull Ollama model "${model}".`,
    });
  }
}

async function probeReadiness({ baseURL, model }) {
  const normalizedBaseUrl = String(baseURL || OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalizedBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0, num_predict: 16 },
        messages: [
          { role: "system", content: "Reply with READY only." },
          { role: "user", content: "READY" },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response: ${text.slice(0, 200)}`);
    }
    const content =
      (parsed && parsed.message && typeof parsed.message.content === "string" ? parsed.message.content : "") ||
      (parsed && typeof parsed.response === "string" ? parsed.response : "");
    if (!content.trim()) {
      throw new Error("empty completion");
    }
    return { ok: true, content };
  } catch (err) {
    throw asLocalLlmError(err, {
      code: "PROBE_FAILED",
      stage: "PROBING",
      message: `Probe inference failed for Ollama model "${model}".`,
    });
  }
}

module.exports = {
  OLLAMA_DEFAULT_URL,
  detectInstallation,
  installOllama,
  startServer,
  listModels,
  pullModel,
  probeReadiness,
};
