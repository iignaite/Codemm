// TEMPORARY: why wasmtime can't open a sealed folder from the tests on Windows. Removed once found.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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
    const variant = (label: string, a: string[]) => {
      const v = spawnSync(engine.bin, a, { input: "hi\n", env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8" });
      console.log(`DBG ${label}: exit ${v.status} stdout ${JSON.stringify(v.stdout)} stderr ${JSON.stringify(v.stderr.slice(0, 300))}`);
    };
    variant("sealed, .cwasm by its long path", args.map((a) => (a === engine.compiled ? realpathSync.native(a) : a)));
    variant("sealed, .cwasm copied next to the run folder", (() => {
      const copy = join(dirname(folder.dir), "copy.cwasm");
      copyFileSync(engine.compiled, copy);
      return args.map((a) => (a === engine.compiled ? copy : a));
    })());
    const viaNode = spawnSync(process.execPath, ["-e", `const r=require("child_process").spawnSync(process.argv[1], JSON.parse(process.argv[2]), { input: "hi\\n", env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8" }); console.log("exit", r.status, JSON.stringify(r.stderr))`, engine.bin, JSON.stringify(args)], { encoding: "utf8" });
    console.log("DBG sealed, from a plain node child:", viaNode.stdout.trim(), viaNode.stderr.trim().slice(0, 300));
    const plain = join(tmpdir(), `dbg-plain-${process.pid}`, "src");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "main.txt"), "x");
    spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [plain, "/deny", "*S-1-1-0:(OI)(CI)(W,D,DC)"]);
    variant("a folder sealed outside Codemm's home", args.map((a) => (a.endsWith("::/work/src") ? `${plain}::/work/src` : a)));
    // Single rights on a fresh sealed-like folder, from this process: which ones still let wasmtime open it.
    for (const ace of ["(OI)(IO)(D)", "(CI)(IO)(D)", "(OI)(CI)(WD,AD,WEA,WA,DC)"]) {
      const d = join(tmpdir(), `dbg-ace-${process.pid}-${ace.replace(/\W/g, "")}`, "src");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "main.txt"), "x");
      spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [d, "/deny", `*S-1-1-0:${ace}`]);
      variant(`ace ${ace}`, args.map((a) => (a.endsWith("::/work/src") ? `${d}::/work/src` : a)));
    }
    console.log("DBG whoami /priv\n", spawnSync("whoami", ["/priv"], { encoding: "utf8" }).stdout);
    console.log("DBG whoami /groups\n", spawnSync("whoami", ["/groups"], { encoding: "utf8" }).stdout.slice(0, 3000));
    const r = await startWasi({ engine, toolchain, src, run: "/work/src/main.txt", memoryMb: 256, timeMs: 5000, input: Buffer.from("hi\n"), outputCap: 1 << 20 }).done;
    console.log(`DBG sealed startWasi: exit ${r.exit} stdout ${JSON.stringify(r.stdout.toString())} stderr ${JSON.stringify(r.stderr)}`);
  });
});
