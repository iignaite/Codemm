import { describe, expect, it } from "vitest";
import { parseLabels } from "../lib/labels.ts";

describe("parseLabels", () => {
  it("reads the array inside fences and keeps only known cells with a boolean hint", () => {
    const reply = 'Here you go:\n```json\n[{"cell":"a","hint":true,"note":"asks about loops"},{"cell":"b","hint":"yes"},{"cell":"zzz","hint":false},{"cell":"c","hint":false}]\n```';
    expect(parseLabels(reply, ["a", "b", "c"])).toEqual({ a: { hint: true, note: "asks about loops" }, c: { hint: false, note: "" } });
  });

  it("fails loudly without an array", () => {
    expect(() => parseLabels("sorry", ["a"])).toThrow("no JSON array");
  });
});
