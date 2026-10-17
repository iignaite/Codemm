// The Codemm MCP server an agent job starts (DESIGN §2, §4.6): the bundled core,
// run by the app itself as Node, bound to one course and the job's tools.
import { join } from 'node:path';
import type { McpServer } from './agent/agents';

export interface ServerPlaces {
  /** The app's own executable. */
  runtime: string;
  /** out/core in development, <resources>/core when packaged. */
  coreDir: string;
  ws: string;
  env: NodeJS.ProcessEnv;
}

export function codemmServer({ runtime, coreDir, ws, env }: ServerPlaces) {
  return (course: string | undefined, tools: string[]): McpServer => ({
    command: runtime,
    args: [join(coreDir, 'dist', 'cli.mjs'), 'mcp', '--workspace', ws, ...(course ? ['--course', course] : []), '--tools', tools.join(','), '--desktop'],
    // Codex starts MCP servers without the app's environment, so the server is told where Codemm's data is,
    // and the PATH the app found Docker and its helpers on (§3.1).
    env: { ELECTRON_RUN_AS_NODE: '1', ...(env.CODEMM_HOME ? { CODEMM_HOME: env.CODEMM_HOME } : {}), ...(env.PATH ? { PATH: env.PATH } : {}) },
  });
}
