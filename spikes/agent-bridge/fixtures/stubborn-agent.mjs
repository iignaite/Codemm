// A fake agent for run.test.ts. It prints a line, starts a child that ignores SIGTERM (like an MCP server that
// won't stop), then either exits ("exit") or ignores SIGTERM and keeps running ("hang").
import { spawn } from "node:child_process";

const mode = process.argv[2];
spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
process.stdout.write('{"type":"started"}\n');
if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(0), 200);
}
