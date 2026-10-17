import { spawn } from "node:child_process";

/**
 * Runs one agent turn: no shell, no stdin, its own process group, stdout read as lines.
 * The spike removes credential variables so every run uses the owner's signed-in subscription.
 */

const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentEnv() {
  const env = { ...process.env };
  for (const name of CREDENTIAL_VARS) delete env[name];
  return env;
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops a process group: SIGTERM, then SIGKILL after `killAfterMs`. Resolves true once it is gone, false if it survived. */
async function stopGroup(child, killAfterMs) {
  if (process.platform === "win32") {
    return new Promise((r) => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("close", (code) => r(code === 0)).on("error", () => r(false)));
  }
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  signal("SIGTERM");
  const start = Date.now();
  let killed = false;
  while (groupAlive(child.pid) && Date.now() - start < killAfterMs + 5000) {
    if (!killed && Date.now() - start >= killAfterMs) {
      signal("SIGKILL");
      killed = true;
    }
    await sleep(50);
  }
  return !groupAlive(child.pid);
}

/**
 * Resolves with { code, cancelled } once the agent has exited; a cancelled run also reports whether its whole group stopped.
 * `parse` turns one stdout line into events; a line that throws or is longer than `maxLine` is skipped.
 */
export function run({ command, args }, parse, { onEvent, signal, cwd, maxLine = 1 << 20, killAfterMs = 3000 } = {}) {
  if (signal?.aborted) return Promise.resolve({ code: null, cancelled: true });
  return new Promise((resolve, reject) => {
    // detached: the agent leads a new process group, so cancelling also stops its MCP server and tools.
    const child = spawn(command, args, { cwd, env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let buffer = "";
    let skipping = false;
    let stopping;
    const cancel = () => {
      stopping ??= stopGroup(child, killAfterMs);
    };
    const emit = (line) => {
      try {
        for (const event of parse(line)) onEvent?.(event);
      } catch {}
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (!skipping && end <= maxLine) emit(buffer.slice(0, end));
        skipping = false;
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > maxLine) {
        buffer = "";
        skipping = true;
      }
    });
    child.stderr.resume(); // drained, never shown: it can carry account details
    child.on("error", reject);
    child.on("close", async (code) => {
      signal?.removeEventListener("abort", cancel);
      if (stopping) {
        resolve({ code, cancelled: true, stopped: await stopping });
        return;
      }
      if (buffer && !skipping && buffer.length <= maxLine) emit(buffer);
      resolve({ code, cancelled: false });
    });
  });
}

/** Runs the agent's own status command. Only the yes/no leaves this function; the output is dropped. */
export function signedIn({ command, args, read }, { timeoutMs = 10_000, maxOutput = 65_536 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The deadline settles the answer even if a grandchild keeps the pipes open; the group is stopped in the background.
    const timer = setTimeout(() => {
      finish(false);
      if (child.pid) stopGroup(child, 0);
    }, timeoutMs);
    const collect = (d) => {
      output = (output + d).slice(0, maxOutput);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(read({ code, output })));
  });
}
