// Runs before every test file. A test that doesn't point CODEMM_HOME at its own folder gets a throwaway one, so
// a check, Run or the self-test (which stage their folders under Codemm's home) never touches the real ~/.codemm.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

if (!process.env.CODEMM_HOME) {
  const home = mkdtempSync(join(tmpdir(), "codemm-test-home-"));
  process.env.CODEMM_HOME = home;
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
}
