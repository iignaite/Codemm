// usage.json in the app's userData folder (DESIGN §4.11): what the agent CLIs reported using, per course and job
// kind. Codemm reads only what the CLIs already print; it never calls a model or reads a credential. It carries
// format_version and is written atomically, like every Codemm-owned file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CourseUsage, UsageTotals } from '../shared/api';
import type { JobKind } from './agent/jobs';

interface UsageFile {
  format_version: 1;
  courses: Record<string, Partial<Record<JobKind, UsageTotals>>>;
  /** Whether the last Claude run counted toward a subscription plan (true) or an API key (false). */
  plan?: boolean;
  /** The last cost Claude reported per session: a resumed session's report covers the whole session. */
  sessions: Record<string, number>;
}

const MAX_SESSIONS = 100;
const zero = (): UsageTotals => ({ input: 0, output: 0, cachedInput: 0, costUsd: 0, runs: 0 });
const add = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cachedInput: a.cachedInput + b.cachedInput,
  costUsd: a.costUsd + b.costUsd,
  runs: a.runs + b.runs,
});

export function usageStore(dir: string) {
  const file = join(dir, 'usage.json');
  // Usage only informs: a file that can't be read starts over instead of stopping the app.
  const read = (): UsageFile => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as UsageFile;
      if (parsed.format_version === 1 && parsed.courses && parsed.sessions) return parsed;
    } catch {
      // Missing or unreadable.
    }
    return { format_version: 1, courses: {}, sessions: {} };
  };
  const write = (next: UsageFile) => {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, file);
  };

  return {
    dir,
    /** Adds one run's report. `session` lets a resumed Claude session's cost count only what's new. */
    record(course: string, kind: JobKind, u: { input: number; output: number; cachedInput?: number; costUsd?: number }, session?: string) {
      const data = read();
      let cost = u.costUsd ?? 0;
      if (u.costUsd !== undefined && session) {
        cost = Math.max(0, u.costUsd - (data.sessions[session] ?? 0));
        delete data.sessions[session];
        data.sessions[session] = Math.max(u.costUsd, cost);
        const ids = Object.keys(data.sessions);
        for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete data.sessions[id];
      }
      const kinds = (data.courses[course] ??= {});
      kinds[kind] = add(kinds[kind] ?? zero(), { input: u.input, output: u.output, cachedInput: u.cachedInput ?? 0, costUsd: cost, runs: 1 });
      write(data);
    },
    notePlan(plan: boolean) {
      const data = read();
      if (data.plan !== plan) write({ ...data, plan });
    },
    plan: (): boolean | undefined => read().plan,
    course(course: string): CourseUsage {
      const kinds = read().courses[course] ?? {};
      return { kinds, total: Object.values(kinds).reduce(add, zero()) };
    },
  };
}
