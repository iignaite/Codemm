// Fetches the wasmtime each installer bundles for the WASI engine (core DESIGN §4.5): the pinned release asset for
// each chip, checked against its SHA-256 before anything is unpacked, keeping only the binary and its license in
// vendor/wasmtime/<os>-<arch>, which packaging.cjs ships with the matching installer. Run by `npm run dist` and CI;
// `node scripts/fetch-wasmtime.mjs` fetches what this computer builds.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RELEASE = 'https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0';

/**
 * @typedef {{ url: string, sha256: string, folder: string, exe: string }} Asset
 * The release file, its SHA-256 (GitHub's asset digest), the folder inside it, and the binary's name.
 */

/** wasmtime 50.0.0, Apache-2.0 WITH LLVM-exception, by electron-builder's `${os}-${arch}`. */
export const ASSETS = /** @type {const} @satisfies {Record<string, Asset>} */ ({
  'mac-arm64': {
    url: `${RELEASE}/wasmtime-v50.0.0-aarch64-macos.tar.xz`,
    sha256: '323dc098dc0455d60f396c404627e967b7033ffcfa29abfffb243126cf82c9d6',
    folder: 'wasmtime-v50.0.0-aarch64-macos',
    exe: 'wasmtime',
  },
  'mac-x64': {
    url: `${RELEASE}/wasmtime-v50.0.0-x86_64-macos.tar.xz`,
    sha256: 'ad14d9fb6a51d1633318426d6df21734127faddc81fe18a3afd70c5964eabeb5',
    folder: 'wasmtime-v50.0.0-x86_64-macos',
    exe: 'wasmtime',
  },
  'win-x64': {
    url: `${RELEASE}/wasmtime-v50.0.0-x86_64-windows.zip`,
    sha256: 'cea9ccc700aaccb2b5507e96ac990ba60104bd7ab39284fb2e67cb64d58efcc4',
    folder: 'wasmtime-v50.0.0-x86_64-windows',
    exe: 'wasmtime.exe',
  },
});

/** What a runner builds (packaging.cjs): both Mac chips on macOS, x64 on Windows. */
export function targets(/** @type {string} */ platform) {
  return platform === 'darwin' ? ['mac-arm64', 'mac-x64'] : platform === 'win32' ? ['win-x64'] : [];
}

/** The system's own tar by absolute path (bsdtar, which reads zip and tar.xz), so none earlier on PATH stands in. */
export function systemTar(/** @type {string} */ platform) {
  return platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
}

const MAX_BYTES = 64 * 2 ** 20;

/** Downloads over https only, redirects included, at most 64 MB, counted as it arrives. */
async function httpsGet(/** @type {string} */ url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.url.startsWith('https://') || !res.body) throw new Error(`Couldn't download ${url}: ${res.status} from ${res.url}`);
  const tooBig = new Error(`${url} is over ${MAX_BYTES} bytes.`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw tooBig;
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw tooBig;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Puts `key`'s wasmtime and LICENSE in `out/key`, unless the pinned one is already there (`out/key.sha256`).
 * @param {string} key
 * @param {{ out: string, asset?: Asset, get?: (url: string) => Promise<Buffer> }} options
 */
export async function fetchWasmtime(key, { out, asset = ASSETS[/** @type {keyof typeof ASSETS} */ (key)], get = httpsGet }) {
  if (!asset) throw new Error(`No wasmtime is pinned for ${key}.`);
  const target = join(out, key);
  const marker = `${target}.sha256`;
  if (existsSync(target) && existsSync(marker) && readFileSync(marker, 'utf8') === asset.sha256) return;
  const bytes = await get(asset.url);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`${asset.url} should have SHA-256 ${asset.sha256}, but has ${digest}.`);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, '.tmp-'));
  try {
    const file = join(work, asset.url.endsWith('.zip') ? 'release.zip' : 'release.tar.xz');
    writeFileSync(file, bytes);
    const keep = [asset.exe, 'LICENSE'].map((f) => `${asset.folder}/${f}`);
    execFileSync(systemTar(process.platform), ['-xf', file, '-C', work, ...keep], { stdio: 'inherit' });
    chmodSync(join(work, asset.folder, asset.exe), 0o755);
    rmSync(target, { recursive: true, force: true });
    rmSync(marker, { force: true });
    renameSync(join(work, asset.folder), target);
    writeFileSync(marker, asset.sha256);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Run as a script, also from a checkout reached through a symlink (import.meta.url is the real path).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'wasmtime');
  for (const key of process.argv.length > 2 ? process.argv.slice(2) : targets(process.platform)) await fetchWasmtime(key, { out });
}
