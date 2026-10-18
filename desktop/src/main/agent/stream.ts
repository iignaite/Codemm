// The line-stream parsing every agent CLI's adapter shares: reading a JSON line, a tool result's text, usage
// counts, research steps, and a version from `--version` output.
import type { AgentEvent, ResearchStep } from './agents';

/** A token count or a cost as reported: a finite number of at least 0, or 0. */
export const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * A usage event from the counts a CLI reports (input not read from cache, cache reads, cache writes, output), or
 * none when it reports nothing. Claude adds its cost estimate.
 */
export function usageOf(u: Record<string, unknown> | undefined, keys: { input: string; read: string; write?: string; output: string }, cost?: unknown): AgentEvent[] {
  const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {};
  if (!u) return 'costUsd' in costUsd ? [{ type: 'usage', input: 0, output: 0, ...costUsd }] : [];
  const read = count(u[keys.read]);
  const input = count(u[keys.input]) + read + (keys.write ? count(u[keys.write]) : 0);
  return [{ type: 'usage', input, output: count(u[keys.output]), cachedInput: read, ...costUsd }];
}

/** Codemm's own tools, as the step each job shows (§4.11). Fixed text: nothing from a tool's arguments or result. */
export const STEP_LABELS: Record<string, string> = {
  list_tracks: 'Checking the installed tracks',
  save_roadmap: 'Saving the roadmap',
  get_roadmap: 'Reading the roadmap',
  save_track: 'Proposing the setup',
  save_lesson: 'Saving the lesson',
  save_exercise: 'Codemm is checking the exercise',
  next_step: 'Checking the next step',
  progress: 'Checking your progress',
  get_exercise: 'Reading the activity',
  get_lesson: 'Reading the lesson',
  mark_lesson_read: 'Noting the lesson as read',
};

export const searchOf = (query: unknown): ResearchStep[] =>
  typeof query === 'string' && query.trim() ? [{ kind: 'search', query: query.trim().slice(0, 120) }] : [];

/**
 * An https page: shown as host and path, kept whole (query included, fragment dropped) for the roadmap's sources.
 * Anything else (http, files) or a link over core's 2,000 characters shows nothing.
 */
export function readOf(url: unknown): ResearchStep | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    const href = `https://${u.host}${u.pathname}${u.search}`;
    if (href.length > 2000) return undefined;
    const path = u.pathname === '/' ? '' : u.pathname;
    return { kind: 'read', url: `${u.host}${path}`.slice(0, 200), href };
  } catch {
    return undefined;
  }
}

export const stepOf = (tool: string): ResearchStep[] => (STEP_LABELS[tool] ? [{ kind: 'step', label: STEP_LABELS[tool] }] : []);
export const progress = (steps: (ResearchStep | undefined)[]): AgentEvent[] => steps.flatMap((step) => (step ? [{ type: 'progress' as const, step }] : []));

export function json(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): v is string => typeof v === 'string';
export const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Known plan-limit markers in an agent's error (§6.1). Unverified until each is recorded as a fixture. */
export const PLAN_LIMIT = /usage limit|rate limit|\b429\b/i;
export const TEXT_MAX = 2000;
/** The text of a tool result's content: a string, or text parts. */
export const textOf = (content: unknown): string =>
  (str(content) ? content : Array.isArray(content) ? content.map((c) => (str(c?.text) ? c.text : '')).join('\n') : '').slice(0, TEXT_MAX);
export const plain = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
export const versionRead = (pattern: RegExp) => ({ code, output }: { code: number | null; output: string }) =>
  code === 0 ? (plain(output).match(pattern)?.[1] ?? null) : null;
