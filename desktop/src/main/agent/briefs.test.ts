// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../../../src/mcp';
import { JOB_BRIEFS } from '../../../../src/templates';
import { briefsFrom, courseId } from './briefs';
import { JOBS, type JobKind } from './jobs';

const briefs = briefsFrom(JOB_BRIEFS);

describe('job briefs', () => {
  it("start with core's brief for the job, then add only the job's details", () => {
    const research = briefs.research('react-1', 'React', 'HTML', 'in-depth');
    expect(research.startsWith(JOB_BRIEFS.research)).toBe(true);
    expect(research).toContain('Course id: react-1');
    expect(research).toContain('React');
    expect(research).toContain('They already know: HTML');
    // The learner chose how deep: the number of single-skill topics follows it.
    expect(research).toContain('Depth: in depth, about 25 to 30 topics');
    expect(briefs.research('r', 'React', '', 'overview')).toContain('Depth: an overview, about 8 topics');
    expect(briefs.research('r', 'React', '', 'standard')).toContain('Depth: standard, about 15 topics');
    expect(briefs.easier('state', 'State').startsWith(JOB_BRIEFS.roadmap)).toBe(true);
    expect(briefs.setup('react@1', 'io', 'no test runner')).toContain('no test runner');
    // The exact track: a proposal for another id or version doesn't set up this course.
    // Found in the macOS journey: a unit-only track for an io course left the course unable to go on.
    expect(briefs.setup('python@3', 'io')).toContain('Propose exactly the track `python@3`: id `python`, version 3, offering style `io`.');
    expect(briefs.author()).toBe(JOB_BRIEFS.author);
  });

  it("gives the tutor the learner's own code and question", () => {
    const tutor = briefs.tutor('the activity "count-1"', 'Why?', { 'main.c': 'int main() {}' });
    expect(tutor.startsWith(JOB_BRIEFS.tutor)).toBe(true);
    expect(tutor).toContain('main.c');
    expect(tutor).toContain('int main() {}');
    expect(tutor.endsWith('They ask: Why?')).toBe(true);
  });

  it('makes a new course id that core accepts', () => {
    expect(courseId('C++ Pointers & Memory!', 0)).toBe('c-pointers-memory-0');
    expect(courseId('日本語', 35)).toBe('course-z');
    expect(courseId('x'.repeat(100), 1)).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });
});

// JOBS is the one list of each job's Codemm tools (DESIGN §3.2); core's briefs must keep to it.
describe('each job\'s tools and its brief', () => {
  const kinds = Object.keys(JOBS) as JobKind[];
  const named = (brief: string) => new Set(brief.match(new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`, 'g')));

  it('has a core brief for exactly the desktop\'s jobs, so the two JobKinds agree', () => {
    expect(Object.keys(JOB_BRIEFS).sort()).toEqual([...kinds].sort());
  });

  it('gives each job only real Codemm tools', () => {
    for (const k of kinds) for (const t of JOBS[k].tools) expect([k, (TOOL_NAMES as readonly string[]).includes(t)]).toEqual([k, true]);
  });

  it.each(kinds)('the %s brief names only its own tools', (kind) => {
    expect([...named(JOB_BRIEFS[kind])].filter((t) => !JOBS[kind].tools.includes(t))).toEqual([]);
  });

  it('keeps the tutor away from saves', () => {
    expect(JOBS.tutor.tools.filter((t) => t.startsWith('save_'))).toEqual([]);
  });
});
