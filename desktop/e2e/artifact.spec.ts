import { extractFile, listPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// #14: the installer carries no development mock or demo curriculum. Reads the
// packaged app named by CODEMM_RESOURCES (set by CI after `npm run dist`).
const resources = process.env.CODEMM_RESOURCES;
// Strings only the mock (src/main/mock.ts) contains: its scenario switch and its demo React course.
// (main.js may still name the mock in its development-only branch; that loads nothing when packaged.)
const DEMO = /Unknown mock scenario|Click Counter|Counter\.jsx/;

test('the packaged app carries no mock or demo curriculum', () => {
  test.skip(!resources, 'needs CODEMM_RESOURCES');
  const asar = join(resources!, 'app.asar');
  // listPackage gives native paths ("\\out\\main\\main.js" on Windows); extractFile needs them without the leading separator.
  const entries = listPackage(asar, { isPack: false }).map((raw) => ({ raw: raw.replace(/^[\\/]/, ''), path: raw.replaceAll('\\', '/').replace(/^\//, '') }));
  const files = entries.map((e) => e.path);
  expect(files).toContain('out/main/main.js');
  expect(files.filter((f) => /mock/i.test(f))).toEqual([]);
  const scripts = entries.filter((e) => e.path.endsWith('.js')).map((e) => [e.path, extractFile(asar, e.raw).toString('utf8')] as const);
  const core = readdirSync(join(resources!, 'core'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => [`core/${f}`, readFileSync(join(resources!, 'core', f), 'utf8')] as const);
  expect([...scripts, ...core].filter(([, text]) => DEMO.test(text)).map(([f]) => f)).toEqual([]);
});

// The WASI engine's wasmtime (core DESIGN §4.5): this installer's own, with its license, signed with the app so it runs.
const HELLO = `(module
  (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "hi\\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 16)) (i32.store (i32.const 4) (i32.const 3))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`;

test('the packaged app carries a wasmtime that runs', () => {
  test.skip(!resources, 'needs CODEMM_RESOURCES');
  const exe = process.platform === 'win32' ? 'wasmtime.exe' : 'wasmtime';
  expect(readdirSync(join(resources!, 'wasmtime')).sort()).toEqual(['LICENSE', exe]);
  const wasmtime = join(resources!, 'wasmtime', exe);
  expect(execFileSync(wasmtime, ['--version'], { encoding: 'utf8' })).toMatch(/^wasmtime 50\.0\.0 /);
  const dir = mkdtempSync(join(tmpdir(), 'codemm-wasm-'));
  try {
    writeFileSync(join(dir, 'hello.wat'), HELLO);
    // Compiling and running the module needs executable memory, which a hardened runtime without the entitlement refuses.
    expect(execFileSync(wasmtime, ['run', '-C', 'cache=n', join(dir, 'hello.wat')], { encoding: 'utf8' })).toBe('hi\n');
    // As core runs a toolchain (core §4.5): compiled once at install, then run precompiled, under a time limit.
    execFileSync(wasmtime, ['compile', '-W', 'epoch-interruption=y', join(dir, 'hello.wat'), '-o', join(dir, 'hello.cwasm')]);
    expect(execFileSync(wasmtime, ['run', '--allow-precompiled', '-C', 'cache=n', '-W', 'timeout=2s', join(dir, 'hello.cwasm')], { encoding: 'utf8' })).toBe('hi\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
