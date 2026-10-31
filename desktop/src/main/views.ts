// Learner-safe projections of core results (DESIGN §2.2, D4). Everything the
// renderer sees is built here: hidden results become an index and a status,
// paths and ids it doesn't need are dropped, and tutor replies pass the
// reply filter.
import type { Activity, CheckResult, ExampleRun, Lesson, Roadmap, TestView, TryResult } from '../shared/api';
import type { CoreCheckView, CoreExercise, CoreLesson, CoreRoadmap } from './core/types';
import { isSafeLink } from './links';

// Core marks a hidden result with its index. The name check is only a backstop: it can hide more, never show more.
const HIDDEN = /^hidden #(\d+)$/;

function testViews(tests: CoreCheckView['tests']): TestView[] {
  return tests.map((t): TestView => {
    const named = HIDDEN.exec(t.name);
    if (t.index !== undefined || named) return { hidden: true, index: t.index ?? Number(named![1]), status: t.status };
    return { hidden: false, name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}), ...(t.actual !== undefined ? { actual: t.actual } : {}) };
  });
}

export function checkView(core: CoreCheckView, concept: { stuck: boolean; mastered: boolean; later: boolean }): CheckResult {
  return { kind: 'graded', passed: core.passed, total: core.total, tests: testViews(core.tests), recorded: core.recorded, stuck: concept.stuck, mastered: concept.mastered, later: concept.later };
}

export function tryView(core: CoreCheckView): TryResult {
  return { kind: 'ran', passed: core.passed, total: core.total, tests: testViews(core.tests).filter((t) => !t.hidden) };
}

/**
 * A track's name for the learner, from its ref: `Python` for `python@1`, `Node Js` for `node-js@2`. No version, and
 * no list of names: Codemm knows no language, so a name the track gives itself is a later step (1.1).
 */
export const trackName = (ref: string) =>
  ref
    .split('@')[0]
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

/**
 * Why the last setup proposal failed, in Codemm's own words. Only the failed gate's name is read from core's message,
 * never what the message quotes (the build's or the test runner's output).
 */
export function setupWhy(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const gate = /^Gate "([^"]+)" failed:/.exec(message)?.[1];
  if (gate === 'build') return "The last try didn't build.";
  if (gate === 'valid') return "The last try's files weren't valid.";
  if (gate?.startsWith('probe') || gate === 'deterministic') return "The last try built, but its tests didn't work.";
  return "The last try didn't pass Codemm's checks.";
}

/** A roadmap as the window sees it, named `title`. Core accepts only https sources; main checks again before anything reaches the window (§2.1). */
export function roadmapView(r: CoreRoadmap, installed: boolean, title = r.goal): Roadmap {
  return {
    title,
    goal: r.goal,
    track: r.track ? trackName(r.track) : '',
    activities: r.style !== 'none',
    installed,
    concepts: r.concepts.map((c) => ({ id: c.id, title: c.title, requires: [...c.requires] })),
    sources: (r.sources ?? []).filter((s) => isSafeLink(s.url)).map((s) => ({ title: s.title, url: s.url })),
  };
}

/** A lesson as the window sees it: named fields only, examples as file lists. */
export function lessonView(l: CoreLesson): Lesson {
  return {
    id: l.id,
    concept: l.concept,
    title: l.title,
    markdown: l.markdown,
    notes: l.notes,
    examples: l.examples.map((files) => ({ files: Object.entries(files).map(([path, text]) => ({ path, text })) })),
    ...(l.style ? { style: l.style } : {}),
  };
}

/** One run of a lesson example, from core's capped output. */
export const exampleRunView = (r: { exit: number; output: string; errors: string }): ExampleRun => ({ kind: 'ran', exit: r.exit, output: r.output, errors: r.errors });

/**
 * A heading's text as words: no code-span backticks, emphasis or closing #s, which the title shows as plain text. A
 * code span is literal, so it is set aside while emphasis is removed: `__init__` keeps its underscores.
 */
function plainTitle(heading: string): string {
  const code: string[] = [];
  return heading
    .replace(/\s+#+\s*$/, '')
    .replace(/`([^`]*)`/g, (_, span: string) => `\uE000${code.push(span) - 1}\uE001`)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => code[Number(i)])
    .trim();
}

/** The statement's first heading is the activity's title; the rest is its text. */
export function activityView(ex: CoreExercise, files: Record<string, { text: string; digest: string }>, concept: string): Activity {
  const m = /^#\s+([^\n]+)\n+/.exec(ex.statement);
  return {
    id: ex.exercise,
    concept,
    title: m ? plainTitle(m[1]) : 'Activity',
    statement: m ? ex.statement.slice(m[0].length) : ex.statement,
    visibleTests: ex.visibleTests.map((t) => ({ name: t.name, ...(t.input !== undefined ? { input: t.input } : {}), ...(t.expected !== undefined ? { expected: t.expected } : {}) })),
    files: ex.files.filter((p) => files[p]).map((path) => ({ path, text: files[path].text, digest: files[path].digest })),
    ...(ex.style === 'io' && ex.run ? { run: ex.run } : {}),
  };
}

// ---------- the reply filter (§2.2) ----------

export const HELD_BACK = 'Codemm held back a reply that showed hidden material.';
const MIN_LINE = 24;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The normalized lines, 24 characters or longer, of an exercise's hidden material (core hiddenMaterial). */
export function hiddenLines(texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => t.split('\n')).map(normalize).filter((l) => l.length >= MIN_LINE))];
}

/** A backstop, not proof: a paraphrase passes it. */
export function filterReply(text: string, hidden: string[]): string {
  const reply = normalize(text);
  return hidden.some((line) => reply.includes(line)) ? HELD_BACK : text;
}
