// Learner-safe projections of core results (DESIGN §2.2, D4). Everything the
// renderer sees is built here: hidden results become an index and a status,
// paths and ids it doesn't need are dropped, and tutor replies pass the
// reply filter.
import type { Activity, CheckResult, TestView, TryResult } from '../shared/api';
import type { CoreCheckView, CoreExercise } from './core/types';

const HIDDEN = /^hidden #(\d+)$/;

function testViews(tests: CoreCheckView['tests']): TestView[] {
  return tests.map((t): TestView => {
    const hidden = HIDDEN.exec(t.name);
    if (hidden) return { hidden: true, index: Number(hidden[1]), status: t.status };
    return { hidden: false, name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}), ...(t.actual !== undefined ? { actual: t.actual } : {}) };
  });
}

export function checkView(core: CoreCheckView, concept: { stuck: boolean; mastered: boolean }): CheckResult {
  return { kind: 'graded', passed: core.passed, total: core.total, tests: testViews(core.tests), recorded: core.recorded, stuck: concept.stuck, mastered: concept.mastered };
}

export function tryView(core: CoreCheckView): TryResult {
  return { kind: 'ran', passed: core.passed, total: core.total, tests: testViews(core.tests).filter((t) => !t.hidden) };
}

/** The statement's first heading is the activity's title; the rest is its text. */
export function activityView(ex: CoreExercise, files: Record<string, { text: string; digest: string }>, concept: string): Activity {
  const m = /^#\s+([^\n]+)\n+/.exec(ex.statement);
  return {
    id: ex.exercise,
    concept,
    title: m ? m[1].trim() : 'Activity',
    statement: m ? ex.statement.slice(m[0].length) : ex.statement,
    visibleTests: ex.visibleTests.map((t) => ({ name: t.name, ...(t.input !== undefined ? { input: t.input } : {}), ...(t.expected !== undefined ? { expected: t.expected } : {}) })),
    files: ex.files.filter((p) => files[p]).map((path) => ({ path, text: files[path].text, digest: files[path].digest })),
  };
}

// ---------- the reply filter (§2.2) ----------

export const HELD_BACK = 'Codemm held back a reply that showed hidden material.';
const MIN_LINE = 24;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const HIDDEN_FILES = /^(solution|mutants|tests\/hidden)\//;

/** The normalized lines, 24 characters or longer, of an exercise's solution, mutants, hidden tests and hidden expected outputs. */
export function hiddenLines(files: Record<string, string>, expected: Record<string, string> = {}): string[] {
  const texts = [
    ...Object.entries(files).filter(([path]) => HIDDEN_FILES.test(path)).map(([, text]) => text),
    ...Object.entries(expected).filter(([key]) => key.startsWith('hidden/')).map(([, text]) => text),
  ];
  return [...new Set(texts.flatMap((t) => t.split('\n')).map(normalize).filter((l) => l.length >= MIN_LINE))];
}

/** A backstop, not proof: a paraphrase passes it. */
export function filterReply(text: string, hidden: string[]): string {
  const reply = normalize(text);
  return hidden.some((line) => reply.includes(line)) ? HELD_BACK : text;
}
