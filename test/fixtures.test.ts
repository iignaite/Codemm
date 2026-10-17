import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test fixtures", () => {
  // The fixture tracks' scripts run in Linux containers, so a CRLF checkout (Windows) would break them.
  it("keep LF line endings on every OS", () => {
    const dir = join(import.meta.dirname, "fixtures");
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    const crlf = files.map((e) => join(e.parentPath, e.name)).filter((f) => readFileSync(f, "utf8").includes("\r"));
    expect(crlf).toEqual([]);
  });
});
