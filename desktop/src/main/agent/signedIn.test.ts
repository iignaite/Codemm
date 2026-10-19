// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../testing/temp';
import { signedInOf } from './signedIn';

/** A stand-in agent whose status command takes `ms` the first time, then `thenMs`, and prints `output`. */
function slowAgent(output: string, ms: number, thenMs = ms) {
  const dir = tempDir('codemm-slow-agent-');
  const runs = join(dir, 'runs');
  writeFileSync(runs, '');
  const script = join(dir, 'agent.js');
  writeFileSync(
    script,
    `const fs = require('fs');
const first = fs.readFileSync(${JSON.stringify(runs)}, 'utf8') === '';
fs.appendFileSync(${JSON.stringify(runs)}, 'x');
setTimeout(() => process.stdout.write(${JSON.stringify(output)}), first ? ${ms} : ${thenMs});`,
  );
  return { exe: { path: script, js: true }, runs: () => readFileSync(runs, 'utf8').length };
}

describe("the agent's sign-in check (§3.1)", () => {
  // Bounds leave a slow CI machine seconds to start Node before the first answer is due.
  it('asks once more, with longer, when a busy computer makes the first answer late', { timeout: 30_000 }, async () => {
    const agent = slowAgent('{"loggedIn":true}', 60_000, 50);
    expect(await signedInOf('claude', agent.exe, [3000, 20_000])).toBe(true);
    expect(agent.runs()).toBe(2);
  });

  it("says signed out only when the agent says so, and can't tell when it never answers", { timeout: 30_000 }, async () => {
    expect(await signedInOf('claude', slowAgent('{"loggedIn":false}', 0).exe, [10_000])).toBe(false);
    const silent = slowAgent('{"loggedIn":true}', 60_000);
    expect(await signedInOf('claude', silent.exe, [3000, 3000])).toBeNull();
    expect(silent.runs()).toBe(2);
  });

  it("can't tell from an answer that isn't one, or a no while the network is down, and doesn't ask again", { timeout: 30_000 }, async () => {
    const garbled = slowAgent('Segmentation fault', 0);
    expect(await signedInOf('claude', garbled.exe, [10_000, 10_000])).toBeNull();
    expect(garbled.runs()).toBe(1);
    expect(await signedInOf('cursor', slowAgent('Not logged in\nError: getaddrinfo ENOTFOUND api2.cursor.sh', 0).exe, [10_000])).toBeNull();
    // A clear yes stays a yes, whatever else it prints.
    expect(await signedInOf('cursor', slowAgent('Logged in as someone\nwarning: getaddrinfo ENOTFOUND telemetry', 0).exe, [10_000])).toBe(true);
  });
});
