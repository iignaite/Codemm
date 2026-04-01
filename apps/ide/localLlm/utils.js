const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function existsExecutable(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
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

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 120_000;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
            reject(Object.assign(new Error(`Command timed out after ${timeoutMs}ms.`), { code: "ETIMEDOUT", stdout, stderr }));
          }, timeoutMs)
        : null;

    child.stdout?.on("data", (buf) => {
      const text = String(buf ?? "");
      stdout += text;
      if (typeof opts.onStdout === "function" && text) opts.onStdout(text);
    });
    child.stderr?.on("data", (buf) => {
      const text = String(buf ?? "");
      stderr += text;
      if (typeof opts.onStderr === "function" && text) opts.onStderr(text);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

function httpGetJson(url, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith("https:") ? https : http;
    const req = client.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) return reject(new Error(`HTTP ${code}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

function downloadToFile(url, destination, opts = {}) {
  return new Promise((resolve, reject) => {
    const seen = new Set();

    const attempt = (rawUrl) => {
      if (seen.has(rawUrl)) return reject(new Error("Redirect loop while downloading."));
      seen.add(rawUrl);

      const parsed = new URL(rawUrl);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.get(parsed, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          return attempt(nextUrl);
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${code}.`));
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const out = fs.createWriteStream(destination);
        const total = Number.parseInt(String(res.headers["content-length"] || "0"), 10);
        let downloaded = 0;

        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (typeof opts.onProgress === "function") {
            opts.onProgress({ downloaded, total: Number.isFinite(total) ? total : 0 });
          }
        });
        res.on("error", (err) => {
          out.destroy();
          reject(err);
        });
        out.on("error", reject);
        out.on("finish", () => resolve({ destination, downloaded, total: Number.isFinite(total) ? total : 0 }));

        res.pipe(out);
      });
      req.on("error", reject);
      req.setTimeout(typeof opts.timeoutMs === "number" ? opts.timeoutMs : 10 * 60_000, () => {
        req.destroy(new Error("download timeout"));
      });
    };

    attempt(url);
  });
}

module.exports = {
  sleep,
  existsExecutable,
  commandExists,
  runCommand,
  httpGetJson,
  downloadToFile,
};
