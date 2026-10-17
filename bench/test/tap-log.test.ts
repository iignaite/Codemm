import { describe, expect, it } from "vitest";
import { parseTapLog, tapRecords } from "../lib/tap-log.ts";

describe("tapRecords", () => {
  it("keeps tools/call requests and results, ignores everything else", () => {
    expect(tapRecords(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "save_exercise", arguments: { files: {} } } }), "in")).toEqual([
      { kind: "call", id: 3, name: "save_exercise", args: { files: {} } },
    ]);
    expect(tapRecords(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text: 'Gate "starter" failed' }] } }), "out")).toEqual([
      { kind: "result", id: 3, isError: true, text: 'Gate "starter" failed' },
    ]);
    expect(tapRecords(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "in")).toEqual([]);
    expect(tapRecords(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "in")).toEqual([]);
    expect(tapRecords("not json", "out")).toEqual([]);
  });

  it("treats JSON-RPC errors as tool errors", () => {
    expect(tapRecords(JSON.stringify({ id: 9, error: { code: -32602, message: "bad args" } }), "out")).toEqual([{ kind: "result", id: 9, isError: true, text: "bad args" }]);
  });
});

describe("parseTapLog", () => {
  it("pairs results by server process and id, in call order", () => {
    const log = [
      { pid: 1, kind: "call", id: 2, name: "save_track", args: {} },
      { pid: 2, kind: "call", id: 2, name: "progress", args: {} },
      { pid: 2, kind: "result", id: 2, isError: false, text: "{}" },
      { pid: 1, kind: "result", id: 2, isError: true, text: "Gate failed" },
      { pid: 1, kind: "result", id: 1, isError: false, text: "tools list, unmatched" },
      { pid: 1, kind: "call", id: 3, name: "save_track", args: {} },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(parseTapLog(`${log}\n{torn`)).toEqual([
      { name: "save_track", args: {}, done: true, isError: true, text: "Gate failed" },
      { name: "progress", args: {}, done: true, isError: false, text: "{}" },
      { name: "save_track", args: {}, done: false, isError: false, text: "" },
    ]);
  });
});
