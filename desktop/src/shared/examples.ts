// Where a lesson places its examples (core DESIGN §5): a fenced code block whose info string is
// `example` and whose only line is the example's number.
const FENCE = /^```example[ \t]*\r?\n[ \t]*(\d+)[ \t]*\r?\n```[ \t]*$/gm;

export type LessonPart = { markdown: string } | { example: number };

/** The lesson's Markdown cut at each example block, in order. */
export function splitExamples(markdown: string): LessonPart[] {
  const parts: LessonPart[] = [];
  let at = 0;
  for (const m of markdown.matchAll(FENCE)) {
    if (m.index > at) parts.push({ markdown: markdown.slice(at, m.index) });
    parts.push({ example: Number(m[1]) });
    at = m.index + m[0].length;
  }
  if (at < markdown.length) parts.push({ markdown: markdown.slice(at) });
  return parts;
}
