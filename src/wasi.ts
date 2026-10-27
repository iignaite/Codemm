import { spawnSync } from "node:child_process";

/**
 * The WASI engine (DESIGN §4.5): wasmtime runs a WASI track's code, with no Docker, VM or admin rights. The only
 * place Codemm starts wasmtime.
 */

/** wasmtime's path: CODEMM_WASMTIME (the desktop app's bundled copy), else `wasmtime` on PATH; undefined when neither runs. */
export function wasmtimePath(): string | undefined {
  const configured = process.env.CODEMM_WASMTIME;
  for (const bin of configured ? [configured] : ["wasmtime"]) {
    if (spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0) return bin;
  }
  return undefined;
}
