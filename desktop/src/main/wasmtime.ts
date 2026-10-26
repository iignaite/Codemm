// The wasmtime this app bundles for the WASI engine (core DESIGN §4.5): packaging.cjs ships this chip's copy in
// <resources>/wasmtime; in development, scripts/fetch-wasmtime.mjs puts it in vendor/wasmtime/<os>-<arch>.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The wasmtime in `dir`, or none when it isn't there (core then looks for one on PATH). */
export function wasmtimeIn(dir: string, platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): string | undefined {
  const file = join(dir, platform === 'win32' ? 'wasmtime.exe' : 'wasmtime');
  return exists(file) ? file : undefined;
}
