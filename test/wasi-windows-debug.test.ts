// TEMPORARY: why wasmtime can't open a sealed folder from the tests on Windows. Removed once found.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { stageRunFolder } from "../src/runs.js";
import { codemmHome } from "../src/store.js";
import { prepareWasi, sealReadOnly, startWasi, wasiArgs } from "../src/wasi.js";
import { fixture, wasmtimeUp } from "./wasi-engine.js";

const icacls = (p: string) => spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [p], { encoding: "utf8" }).stdout;

describe.runIf(process.platform === "win32" && wasmtimeUp)("windows debug", () => {
  it("prints why", async () => {
    const toolchain = fixture("cat");
    const engine = await prepareWasi(toolchain);
    console.log("DBG home", codemmHome(), "tmpdir", tmpdir(), "engine", JSON.stringify(engine));
    console.log("DBG compiled dir", readdirSync(dirname(engine.compiled)).join(","));
    const folder = stageRunFolder();
    const src = join(folder.dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "main.txt"), "x");
    const args = wasiArgs({ engine, toolchain, src, run: "/work/src/main.txt", memoryMb: 256, timeMs: 5000 });
    const sync = (label: string) => {
      const r = spawnSync(engine.bin, args, { input: "hi\n", env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8" });
      console.log(`DBG ${label}: exit ${r.status} stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
    };
    console.log("DBG args", JSON.stringify(args));
    sync("unsealed spawnSync");
    sealReadOnly(folder.dir);
    console.log("DBG icacls src\n", icacls(src));
    console.log("DBG icacls compiled\n", icacls(engine.compiled));
    console.log("DBG icacls home\n", icacls(codemmHome()));
    console.log("DBG icacls runs\n", icacls(dirname(folder.dir)));
    sync("sealed spawnSync");
    const r = await startWasi({ engine, toolchain, src, run: "/work/src/main.txt", memoryMb: 256, timeMs: 5000, input: Buffer.from("hi\n"), outputCap: 1 << 20 }).done;
    console.log(`DBG sealed startWasi: exit ${r.exit} stdout ${JSON.stringify(r.stdout.toString())} stderr ${JSON.stringify(r.stderr)}`);
  });
});
