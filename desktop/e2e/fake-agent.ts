import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './temp';

const windows = process.platform === 'win32';

/** A fake Claude Code written in JavaScript, installed the way npm installs one. */
export function fakeAgent(): string {
  const dir = tempDir('codemm-agent-');
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === '--version') console.log('2.1.283 (Claude Code)');
else if (args === 'auth status --json') console.log(JSON.stringify({ loggedIn: true, email: 'never-shown@example.com' }));
`;
  if (windows) {
    mkdirSync(join(dir, 'node_modules', 'fake-claude'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'fake-claude', 'cli.js'), script);
    writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*\r\n');
  } else {
    writeFileSync(join(dir, 'claude'), script);
    chmodSync(join(dir, 'claude'), 0o755);
  }
  return dir;
}
