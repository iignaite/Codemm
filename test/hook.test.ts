import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeHook } from "../src/hook.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "codemm-hook-"));
});
const input = (tool: string, file: string) => JSON.stringify({ tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file } });
const assist = (on: boolean) => writeFileSync(join(ws, "codemm.json"), JSON.stringify({ format_version: 1, assist: on }));

describe("claudeHook", () => {
  it.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])("blocks %s on an exercise file in practice mode", (tool) => {
    const r = claudeHook(ws, input(tool, join(ws, "exercises/c/sum/main.c")));
    expect(r.exit).toBe(2);
    expect(r.message).toMatch(/hint/i);
  });

  it("allows edits once assist mode is on", () => {
    assist(true);
    expect(claudeHook(ws, input("Edit", join(ws, "exercises/c/sum/main.c"))).exit).toBe(0);
  });

  it("allows edits outside exercises/, including paths that only look inside", () => {
    expect(claudeHook(ws, input("Write", join(ws, "notes.md"))).exit).toBe(0);
    expect(claudeHook(ws, input("Write", `${ws}/exercises/../notes.md`)).exit).toBe(0);
    expect(claudeHook(ws, input("Write", join(ws, "exercises-old/a"))).exit).toBe(0);
  });

  it("resolves relative paths against the workspace", () => {
    expect(claudeHook(ws, input("Edit", "exercises/c/sum/main.c")).exit).toBe(2);
  });

  it("sees through symlinked aliases of the workspace", () => {
    const alias = join(mkdtempSync(join(tmpdir(), "codemm-alias-")), "ws");
    symlinkSync(ws, alias);
    expect(claudeHook(ws, input("Edit", join(alias, "exercises/c/sum/main.c"))).exit).toBe(2);
    expect(claudeHook(alias, input("Edit", join(ws, "exercises/c/sum/main.c"))).exit).toBe(2);
  });

  it("treats names that start with dots as ordinary names, not as a step out", () => {
    expect(claudeHook(ws, input("Write", join(ws, "exercises/..notes/file"))).exit).toBe(2);
    expect(claudeHook(ws, input("Write", join(ws, "..exercises/file"))).exit).toBe(0);
  });

  it("warns on well-formed JSON with no usable path", () => {
    const r = claudeHook(ws, JSON.stringify({ tool_name: "Edit", tool_input: { file_path: 42 } }));
    expect(r).toMatchObject({ exit: 0, message: expect.stringMatching(/couldn't read/i) });
  });

  it("lets malformed input through with a warning instead of breaking the agent", () => {
    const r = claudeHook(ws, "not json");
    expect(r.exit).toBe(0);
    expect(r.message).toMatch(/couldn't read/i);
  });
});
