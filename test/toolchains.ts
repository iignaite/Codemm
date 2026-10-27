import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as store from "../src/store.js";
import { removeTree } from "../src/toolchain.js";

/**
 * Removes a test's Codemm home. Its stored toolchains are sealed (on Windows, by a deny entry on each of their
 * folders), so each is unsealed and removed first, as Codemm removes one.
 */
export function removeHome(home: string): void {
  const toolchains = store.toolchainsDir();
  if (existsSync(toolchains)) for (const name of readdirSync(toolchains)) removeTree(join(toolchains, name));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
