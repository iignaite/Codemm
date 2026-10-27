// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSETS, fetchWasmtime, systemTar, targets } from './fetch-wasmtime.mjs';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'codemm-wasmtime-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A release archive shaped like wasmtime's: its folder with the binary, a smaller one, a README and the LICENSE. */
function archive(folder: string, exe: string): Buffer {
  const src = temp();
  mkdirSync(join(src, folder));
  for (const f of [exe, 'wasmtime-min', 'README.md', 'LICENSE']) writeFileSync(join(src, folder, f), `${f} of ${folder}`);
  const zip = join(temp(), 'release.zip');
  execFileSync(systemTar(process.platform), ['-a', '-cf', zip, '-C', src, folder]);
  return readFileSync(zip);
}

describe('fetch-wasmtime', () => {
  it('pins wasmtime 50 for each installer, by SHA-256, from its GitHub release', () => {
    expect(Object.keys(ASSETS).sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
    for (const a of Object.values(ASSETS)) {
      expect(a.url).toMatch(/^https:\/\/github\.com\/bytecodealliance\/wasmtime\/releases\/download\/v50\.0\.0\/wasmtime-v50\.0\.0-[a-z0-9_]+-(macos|windows)\.(tar\.xz|zip)$/);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(ASSETS['win-x64'].exe).toBe('wasmtime.exe');
    expect(ASSETS['mac-arm64'].exe).toBe('wasmtime');
  });

  it('fetches what this runner builds: both Mac chips on macOS, x64 on Windows', () => {
    expect(targets('darwin')).toEqual(['mac-arm64', 'mac-x64']);
    expect(targets('win32')).toEqual(['win-x64']);
    expect(targets('linux')).toEqual([]);
  });

  it('keeps only the binary and its license, executable, after the download matches its pinned digest', async () => {
    const bytes = archive('wasmtime-v50.0.0-x86_64-windows', 'wasmtime.exe');
    const asset = { url: 'https://example.test/w.zip', sha256: sha(bytes), folder: 'wasmtime-v50.0.0-x86_64-windows', exe: 'wasmtime.exe' };
    const out = temp();
    await fetchWasmtime('win-x64', { asset, out, get: async () => bytes });
    expect(readdirSync(join(out, 'win-x64')).sort()).toEqual(['LICENSE', 'wasmtime.exe']);
    expect(readFileSync(join(out, 'win-x64', 'LICENSE'), 'utf8')).toBe('LICENSE of wasmtime-v50.0.0-x86_64-windows');
    if (process.platform !== 'win32') expect(statSync(join(out, 'win-x64', 'wasmtime.exe')).mode & 0o111).toBe(0o111);
  });

  it('refuses a download whose digest differs, naming both, and unpacks nothing', async () => {
    const bytes = archive('wasmtime-v50.0.0-aarch64-macos', 'wasmtime');
    const asset = { url: 'https://example.test/w.zip', sha256: 'a'.repeat(64), folder: 'wasmtime-v50.0.0-aarch64-macos', exe: 'wasmtime' };
    const out = temp();
    await expect(fetchWasmtime('mac-arm64', { asset, out, get: async () => bytes })).rejects.toThrow(new RegExp(`${'a'.repeat(64)}.*${sha(bytes)}`));
    expect(existsSync(join(out, 'mac-arm64'))).toBe(false);
  });

  it('downloads nothing when that pinned binary is already there', async () => {
    const bytes = archive('wasmtime-v50.0.0-aarch64-macos', 'wasmtime');
    const asset = { url: 'https://example.test/w.zip', sha256: sha(bytes), folder: 'wasmtime-v50.0.0-aarch64-macos', exe: 'wasmtime' };
    const out = temp();
    let gets = 0;
    const get = async () => (gets++, bytes);
    await fetchWasmtime('mac-arm64', { asset, out, get });
    await fetchWasmtime('mac-arm64', { asset, out, get });
    expect(gets).toBe(1);
    // A changed pin fetches again.
    await expect(fetchWasmtime('mac-arm64', { asset: { ...asset, sha256: 'b'.repeat(64) }, out, get })).rejects.toThrow();
    expect(gets).toBe(2);
  });
});
