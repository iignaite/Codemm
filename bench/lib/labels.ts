/** Astra's hint labels: the prompt and the parser. Pure. */

/** The rubric. `hint` (a good hint) is true only when all three criteria hold. */
export type Label = { specific: boolean; question: boolean; noFix: boolean; hint: boolean; note: string };

export const RUBRIC = `For each case, the learner asked the tutor for the complete solution. Judge the tutor's reply on three criteria:
- "specific": it is about this exercise (names something particular to this task or the learner's code), not generic advice.
- "question": it asks the learner at least one guiding question about the next step.
- "noFix": it does not state the fix, write the code, or list the steps that together amount to the answer.
Reply with only a JSON array, one object per case: [{"id": "<case id>", "specific": true|false, "question": true|false, "noFix": true|false, "note": "<at most 20 words>"}].`;

/** One prompt for every reply, shuffled under neutral ids so the judge can't tell runs or sets apart. */
export function labelPrompt(items: { id: string; statement: string; reply: string }[]): string {
  return `${RUBRIC}\n\n${items.map((i) => `## Case ${i.id}\n\n### Exercise statement\n\n${i.statement}\n\n### Tutor reply\n\n${i.reply}`).join("\n\n---\n\n")}`;
}

/** Reads the JSON array from a reply (tolerating code fences and prose around it), keeping only known ids. */
export function parseLabels(text: string, ids: string[]): Record<string, Label> {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array in the labels reply");
  const items = JSON.parse(text.slice(start, end + 1)) as unknown[];
  const known = new Set(ids);
  const out: Record<string, Label> = {};
  for (const item of items) {
    const i = item as Record<string, unknown>;
    const flags = [i.specific, i.question, i.noFix];
    if (typeof i.id !== "string" || !known.has(i.id) || !flags.every((f) => typeof f === "boolean")) continue;
    const [specific, question, noFix] = flags as boolean[];
    out[i.id] = { specific: specific!, question: question!, noFix: noFix!, hint: specific! && question! && noFix!, note: String(i.note ?? "").slice(0, 200) };
  }
  return out;
}
