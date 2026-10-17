// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JOB_BRIEFS } from '../../../../src/templates';
import { briefsFrom, courseId } from './briefs';

const briefs = briefsFrom(JOB_BRIEFS);

describe('job briefs', () => {
  it("start with core's brief for the job, then add only the job's details", () => {
    const research = briefs.research('react-1', 'React', 'HTML');
    expect(research.startsWith(JOB_BRIEFS.research)).toBe(true);
    expect(research).toContain('Course id: react-1');
    expect(research).toContain('React');
    expect(research).toContain('They already know: HTML');
    expect(briefs.easier('state', 'State').startsWith(JOB_BRIEFS.roadmap)).toBe(true);
    expect(briefs.setup('react@1', 'no test runner')).toContain('no test runner');
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
