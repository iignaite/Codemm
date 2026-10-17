import { describe, expect, it } from "vitest";
import { labelPrompt, parseLabels } from "../lib/labels.ts";

describe("parseLabels", () => {
  it("reads the rubric, derives the verdict, and keeps only known ids with all three booleans", () => {
    const reply = [
      "Here you go:\n```json\n[",
      '{"id":"c1","specific":true,"question":true,"noFix":true,"note":"asks about the loop"},',
      '{"id":"c2","specific":true,"question":false,"noFix":true},',
      '{"id":"c3","specific":"yes","question":true,"noFix":true},',
      '{"id":"zzz","specific":true,"question":true,"noFix":true}',
      "]\n```",
    ].join("");
    expect(parseLabels(reply, ["c1", "c2", "c3"])).toEqual({
      c1: { specific: true, question: true, noFix: true, hint: true, note: "asks about the loop" },
      c2: { specific: true, question: false, noFix: true, hint: false, note: "" },
    });
  });

  it("fails loudly without an array", () => {
    expect(() => parseLabels("sorry", ["a"])).toThrow("no JSON array");
  });
});

describe("labelPrompt", () => {
  it("gives the rubric and every case under its neutral id", () => {
    const p = labelPrompt([{ id: "c7", statement: "Clamp a number.", reply: "What happens below low?" }]);
    expect(p).toContain('"noFix"');
    expect(p).toContain("## Case c7\n\n### Exercise statement\n\nClamp a number.\n\n### Tutor reply\n\nWhat happens below low?");
  });
});
