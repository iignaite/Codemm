import { describe, expect, it } from "vitest";
import { npm } from "./npm.js";

describe("npm (test helper)", () => {
  it("runs without blocking the test worker, so vitest's own messages keep flowing during a long build", async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 0);
    const version = npm(["--version"]);
    expect(version).toBeInstanceOf(Promise);
    expect((await version).trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ticked).toBe(true);
  });
});
