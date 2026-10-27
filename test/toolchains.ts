import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as store from "../src/store.js";
import { removeTree } from "../src/toolchain.js";

/**
 * Removes every stored toolchain. Each one's folders are sealed (on Windows, by a deny entry on each folder in it), so
 * each digest's folder is unsealed and removed by itself, as Codemm removes one.
 */
export function removeToolchains(): void {
  const toolchains = store.toolchainsDir();
  if (existsSync(toolchains)) for (const name of readdirSync(toolchains)) removeTree(join(toolchains, name));
}

/** Removes a test's Codemm home, its stored toolchains first. */
export function removeHome(home: string): void {
  removeToolchains();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
