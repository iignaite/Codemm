// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { activityView, checkView, exampleRunView, HELD_BACK, hiddenLines, filterReply, lessonView, setupWhy, tryView } from './views';

const core = {
  exercise: 'state-easy-1',
  passed: 2,
  total: 4,
  recorded: true,
  tests: [
    { name: 'shows zero', status: 'pass' as const },
    { name: 'adds one', status: 'fail' as const, message: 'expected 1', actual: 'Count: 0' },
    { name: 'hidden #1', index: 1, status: 'pass' as const },
    { name: 'hidden #2', index: 2, status: 'fail' as const },
  ],
};

describe('views (§2.2, D4)', () => {
  it("says why the last setup failed from its gate's name only, never what the message quotes", () => {
    expect(setupWhy('Gate "build" failed: the image didn\'t build.\nIt printed:\nCANARY-BUILD-LOG')).toBe("The last try didn't build.");
    expect(setupWhy('Gate "probe pass" failed: the io pass probe should pass every test:\n  01: fail')).toBe("The last try built, but its tests didn't work.");
    expect(setupWhy('Gate "valid" failed: track.yaml must name a test command.')).toBe("The last try's files weren't valid.");
    expect(setupWhy('The track image is missing a tool Codemm needs: sh, timeout.')).toBe("The last try didn't pass Codemm's checks.");
    expect(setupWhy('Gate "CANARY" failed: x')).toBe("The last try didn't pass Codemm's checks.");
    expect(setupWhy(undefined)).toBeUndefined();
  });

  it('reduces hidden results to an index and a status', () => {
    expect(checkView(core, { stuck: false, mastered: false, later: true })).toEqual({
      kind: 'graded',
      passed: 2,
      total: 4,
      recorded: true,
      stuck: false,
      mastered: false,
      later: true,
      tests: [
        { hidden: false, name: 'shows zero', status: 'pass' },
        { hidden: false, name: 'adds one', status: 'fail', message: 'expected 1', actual: 'Count: 0' },
        { hidden: true, index: 1, status: 'pass' },
        { hidden: true, index: 2, status: 'fail' },
      ],
    });
  });

  it("takes a hidden result's index from core's index, not from its name", () => {
    const view = checkView({ ...core, tests: [{ name: 'hidden #7', index: 2, status: 'pass', message: 'secret' }] }, { stuck: false, mastered: false, later: true });
    expect(view).toMatchObject({ tests: [{ hidden: true, index: 2, status: 'pass' }] });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('never forwards a hidden result even if core named it differently', () => {
    const view = checkView({ ...core, tests: [{ name: 'hidden #1', status: 'fail', message: 'secret', actual: 'secret' }] }, { stuck: false, mastered: false, later: true });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('builds a lesson from named fields only, so nothing core adds later reaches the window', () => {
    const lesson = { id: 'l1', concept: 'values', title: 'Values', markdown: '# Values', notes: 'mine', examples: [{ 'main.py': 'print(1)' }], style: 'io' as const, solution: 'SECRET' };
    expect(lessonView(lesson)).toEqual({ id: 'l1', concept: 'values', title: 'Values', markdown: '# Values', notes: 'mine', examples: [{ files: [{ path: 'main.py', text: 'print(1)' }] }], style: 'io' });
    expect(lessonView({ ...lesson, style: undefined })).not.toHaveProperty('style');
  });

  it("builds an example's run from named fields only", () => {
    expect(exampleRunView({ exit: 0, output: '1\n', errors: '', path: '/Users/me/x' } as never)).toEqual({ kind: 'ran', exit: 0, output: '1\n', errors: '' });
  });

  it('Try it shows visible results only', () => {
    expect(tryView({ ...core, recorded: false, tests: core.tests.slice(0, 2), total: 2, passed: 1 })).toMatchObject({ kind: 'ran', passed: 1, total: 2 });
  });

  it('an activity drops paths and ids, and takes its title from the statement', () => {
    const view = activityView(
      { course: 'react', exercise: 'state-easy-1', path: '/Users/me/Codemm/exercises/react/state-easy-1', style: 'io', concepts: ['state'], difficulty: 1, files: ['main.c'], statement: '# Click Counter\n\nMake it count.', visibleTests: [{ name: 'one', input: '1', expected: '2' }] },
      { 'main.c': { text: 'int main(){}', digest: 'a'.repeat(64) } },
      'state',
    );
    expect(view).toEqual({
      id: 'state-easy-1',
      concept: 'state',
      title: 'Click Counter',
      statement: 'Make it count.',
      visibleTests: [{ name: 'one', input: '1', expected: '2' }],
      files: [{ path: 'main.c', text: 'int main(){}', digest: 'a'.repeat(64) }],
    });
    expect(JSON.stringify(view)).not.toContain('/Users/me');
  });

  it('holds back a tutor reply that quotes hidden material verbatim', () => {
    // Core picks the hidden texts (hiddenMaterial); the filter keeps their lines of 24 characters or more.
    const material = hiddenLines(['int main() {\n  printf("the hidden canary answer %d", 42);\n  return 0;\n}\n', 'short\n', 'expected hidden output canary line']);
    expect(material).toContain('printf("the hidden canary answer %d", 42);');
    expect(material).not.toContain('short');
    expect(filterReply('Try:\n```\n   printf("the hidden canary   answer %d", 42);\n```', material)).toBe(HELD_BACK);
    expect(filterReply('It should print expected hidden output canary line.', material)).toBe(HELD_BACK);
    expect(filterReply('Look at what you pass to printf.', material)).toBe('Look at what you pass to printf.');
  });
});
