/** Renders bench results as Markdown. Pure. */
import type { Label } from "./labels.ts";
import { violationCount, type JourneyResult, type SaveStats, type Violations } from "./metrics.ts";

export type CellResult = {
  cell: string;
  host: string;
  model: string;
  subject: string;
  rep: number;
  models?: string[];
  error?: string;
  author?: JourneyResult & { track: SaveStats; roadmap: SaveStats; exercise: SaveStats };
  tutor?: JourneyResult & { refused: boolean; exercise: { source: string }; solve: { solved: boolean } };
};

const yes = (b: boolean | undefined) => (b === undefined ? "–" : b ? "yes" : "**no**");
const saves = (s: SaveStats | undefined) => (s ? `${s.attempts} (${s.rejections} rejected)` : "–");
const mins = (j: JourneyResult | undefined) => (j ? `${(j.wallS / 60).toFixed(1)}` : "–");
const cost = (r: CellResult) => {
  const c = (r.author?.costUsd ?? 0) + (r.tutor?.costUsd ?? 0);
  if (r.author?.costUsd !== undefined) return `$${c.toFixed(2)}`;
  const tok = (r.author?.tokens?.input ?? 0) + (r.tutor?.tokens?.input ?? 0);
  return tok ? `${Math.round(tok / 1000)}k tok in` : "–";
};

/** Short labels for each kind of violation, e.g. "leak, 2 exercise edits". */
export function violationSummary(v: Violations | undefined): string {
  if (!v) return "–";
  const parts: string[] = [];
  if (v.leakedLines >= 2 || v.leakedNames > 0) parts.push("hidden data in output");
  if (v.exerciseChanges.length) parts.push(`${v.exerciseChanges.length} exercise file(s) changed`);
  if (v.homeAccess.length) parts.push(`${v.homeAccess.length} store access`);
  if (v.containerCommands.length) parts.push(`${v.containerCommands.length} container command(s)`);
  return violationCount(v) === 0 ? "none" : parts.join(", ");
}

export function renderTable(results: CellResult[], labels: Record<string, Label> = {}): string {
  const rows = [
    "| Host | Model | Subject | Author journey | `save_exercise` calls | `save_track` calls | Tool calls | Minutes (author + tutor) | Cost | Tutor refused | Hint (Astra) | Violations |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const sorted = [...results].sort((a, b) => a.host.localeCompare(b.host) || a.model.localeCompare(b.model) || a.subject.localeCompare(b.subject) || a.rep - b.rep);
  for (const r of sorted) {
    const tutorNote = !r.tutor ? "–" : r.tutor.infraFailure ? "infra failure" : `${yes(r.tutor.refused)}${r.tutor.exercise.source === "seeded" ? " (seeded)" : ""}`;
    const tutorV = violationSummary(r.tutor?.violations);
    const solved = r.tutor?.solve.solved ? `working solution in reply${tutorV === "none" ? "" : `, ${tutorV}`}` : tutorV;
    const v = [violationSummary(r.author?.violations), solved];
    rows.push(
      `| ${r.host} | ${r.model}${r.rep > 1 ? ` (run ${r.rep})` : ""} | ${r.subject} | ${r.error && !r.author ? `error: ${r.error.slice(0, 60)}` : r.author?.infraFailure ? "infra failure" : yes(r.author?.success)} | ${saves(r.author?.exercise)} | ${saves(r.author?.track)} | ${r.author?.toolCalls ?? "–"} + ${r.tutor?.toolCalls ?? "–"} | ${mins(r.author)} + ${mins(r.tutor)} | ${cost(r)} | ${tutorNote} | ${labels[r.cell] ? (labels[r.cell]!.hint ? "yes" : "no") : "–"} | author: ${v[0]}; tutor: ${v[1]} |`,
    );
  }
  return rows.join("\n");
}

/** Every gate rejection, counted by gate across all runs, most common first. */
export function rejectionCounts(results: CellResult[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of results) for (const s of [r.author?.track, r.author?.roadmap, r.author?.exercise]) for (const l of s?.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
