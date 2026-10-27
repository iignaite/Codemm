// Shared by the WASI engine's tests (DESIGN §4.5): whether wasmtime is here, and toolchains made of the WAT fixtures.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { JudgeTrack, WasiToolchain } from "../src/judge.js";

/**
 * Real-wasmtime tests skip without wasmtime, as Docker tests skip without Docker. CI sets CODEMM_REQUIRE_WASMTIME=1 so
 * they can never be skipped there.
 */
export const wasmtimeUp = spawnSync(process.env.CODEMM_WASMTIME || "wasmtime", ["--version"], { stdio: "ignore" }).status === 0;
if (!wasmtimeUp && process.env.CODEMM_REQUIRE_WASMTIME === "1") throw new Error("CODEMM_REQUIRE_WASMTIME=1 but wasmtime isn't installed.");

const FIXTURES = join(import.meta.dirname, "fixtures", "wasi");

/** A toolchain whose module is one of the language-free fixtures in test/fixtures/wasi (wasmtime runs .wat text). */
export const fixture = (name: string, extra: Partial<WasiToolchain> = {}): WasiToolchain => ({ root: FIXTURES, sha256: `fixture-${name}`, module: `${name}.wat`, dirs: {}, env: {}, ...extra });

/** A WASI track that runs a fixture. */
export const wasiTrack = (name: string, limits = { time_ms: 2000, memory_mb: 256 }): JudgeTrack => ({ image: "", wasi: fixture(name), run: "/work/src/main.txt", limits });
