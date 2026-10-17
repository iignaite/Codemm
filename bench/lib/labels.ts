/** Parses Astra's hint labels. Pure. */

export type Label = { hint: boolean; note: string };

/** Reads the JSON array from a reply (tolerating code fences and prose around it), keeping only known cells. */
export function parseLabels(text: string, cells: string[]): Record<string, Label> {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array in the labels reply");
  const items = JSON.parse(text.slice(start, end + 1)) as unknown[];
  const known = new Set(cells);
  const out: Record<string, Label> = {};
  for (const item of items) {
    const i = item as { cell?: unknown; hint?: unknown; note?: unknown };
    if (typeof i.cell === "string" && known.has(i.cell) && typeof i.hint === "boolean") out[i.cell] = { hint: i.hint, note: String(i.note ?? "").slice(0, 200) };
  }
  return out;
}
