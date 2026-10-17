import { spawn } from "node:child_process";

/**
 * Runs one agent turn: no shell, no stdin, its own process group, stdout read as lines.
 * The spike removes credential variables so every run uses the owner's signed-in subscription.
 */

const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"];

function agentEnv() {
  const env = { ...process.env };
  for (const name of CREDENTIAL_VARS) delete env[name];
  return env;
}

function start({ command, args }, cwd) {
  // detached: the agent leads a new process group, so cancelling also stops its MCP server and tools.
  return spawn(command, args, { cwd, env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  const group = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  group("SIGTERM");
  setTimeout(() => group("SIGKILL"), 3000).unref();
}

/** Resolves with { code, cancelled } once the agent exits; `parse` turns one stdout line into events. */
export function run(launch, parse, { onEvent, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = start(launch, cwd);
    let buffer = "";
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      stop(child);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        for (const event of parse(line)) onEvent?.(event);
      }
    });
    child.stderr.resume(); // drained, never shown: it can carry account details
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      if (buffer && !cancelled) for (const event of parse(buffer)) onEvent?.(event);
      resolve({ code, cancelled });
    });
  });
}

/** Runs the agent's own status command. Only the yes/no leaves this function; the output is dropped. */
export function signedIn({ command, args, read }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(read({ code, output })));
  });
}
