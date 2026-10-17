// A fake agent for run.test.ts. It starts a child that ignores SIGTERM (like an MCP server that won't stop), waits
// until that child is ready, prints a line, then either exits ("exit") or ignores SIGTERM and keeps running ("hang").
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "hang") process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {
  stdio: ["ignore", "pipe", "ignore"],
});
child.stdout.once("data", () => {
  child.stdout.destroy();
  process.stdout.write('{"type":"started"}\n');
  if (mode === "hang") setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(0), 200);
});
