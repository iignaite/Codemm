import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bothEngines, type Check, doctor, wasiEngine } from "../src/doctor.js";
import { tempDir } from "./temp.js";
import { wasmtimeUp } from "./wasi-engine.js";

/** `codemm doctor` shows both engines (DESIGN §4.5): a missing one fails only when the other can't run checks either. */

afterEach(() => vi.unstubAllEnvs());
const noWasmtime = () => vi.stubEnv("CODEMM_WASMTIME", join(tempDir(), "no-wasmtime"));
const noRuntime = () => vi.stubEnv("CODEMM_CONTAINER_CLI", join(tempDir(), "no-docker"));
const row = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe("the WASI engine's row", () => {
  it("fails without wasmtime", async () => {
    noWasmtime();
    expect(await wasiEngine()).toMatchObject({ name: "WASI engine", ok: false, detail: expect.stringMatching(/wasmtime isn't installed/) });
  });

  it.skipIf(!wasmtimeUp)("names wasmtime's version once a module ran with a read-only folder mapped", async () => {
    expect(await wasiEngine()).toMatchObject({ ok: true, detail: expect.stringMatching(/^wasmtime \d+\.\d+/) });
  });
});

describe("bothEngines", () => {
  const runtime = (ok: boolean) => ({ name: "container runtime", ok, detail: ok ? "running" : "No container runtime found." });
  const wasi = (ok: boolean) => ({ name: "WASI engine", ok, detail: ok ? "wasmtime 50.0.0" : "wasmtime isn't installed." });

  it("keeps both rows as they are when both work", () => {
    expect(bothEngines(runtime(true), wasi(true))).toEqual([runtime(true), wasi(true)]);
  });

  it("fails both when neither works", () => {
    expect(bothEngines(runtime(false), wasi(false))).toEqual([runtime(false), wasi(false)]);
  });

  it("doesn't fail wasmtime when a container runtime runs checks", () => {
    const [, w] = bothEngines(runtime(true), wasi(false));
    expect(w).toEqual({ name: "WASI engine", ok: true, detail: "wasmtime isn't installed. Only needed on a computer without a container runtime." });
  });

  it("doesn't fail a missing container runtime when wasmtime runs checks", () => {
    const [r] = bothEngines(runtime(false), wasi(true));
    expect(r).toEqual({ name: "container runtime", ok: true, detail: "No container runtime found. WASI tracks run on wasmtime here; Docker tracks need a container runtime." });
  });
});

describe("doctor with one engine or none", () => {
  it("fails both rows when neither engine is here", async () => {
    noWasmtime();
    noRuntime();
    const checks = await doctor(false);
    expect(row(checks, "container runtime")?.ok).toBe(false);
    expect(row(checks, "WASI engine")?.ok).toBe(false);
  });

  it.skipIf(!wasmtimeUp)("doesn't fail a missing container runtime when wasmtime works", async () => {
    noRuntime();
    const checks = await doctor(false);
    expect(row(checks, "container runtime")).toMatchObject({ ok: true, detail: expect.stringMatching(/WASI tracks run on wasmtime/) });
    expect(row(checks, "WASI engine")?.ok).toBe(true);
    expect(row(checks, "network isolation")).toBeUndefined();
  });
});
