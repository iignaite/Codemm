import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./temp.js";

describe("tempDir", () => {
  it("makes a fresh folder each time, and removeTempDirs removes every one with its contents", () => {
    const a = tempDir("codemm-a-");
    const b = tempDir("codemm-a-");
    expect(a).not.toBe(b);
    writeFileSync(join(a, "f"), "x");
    removeTempDirs();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });
});
