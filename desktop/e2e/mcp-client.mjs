// A tiny MCP stdio client: starts a server command, initializes, calls one
// tool and prints its text. Used by the packaged smoke test (D1).
import { spawn } from 'node:child_process';

export function callTool({ command, args, env }, tool, input = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out; stderr: ${stderr}`)); }, 30_000);
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: tool, arguments: input } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result?.content?.map((c) => c.text).join('') ?? JSON.stringify(msg.error));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codemm-smoke', version: '1' } } });
  });
}
