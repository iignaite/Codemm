// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { activityView, checkView, HELD_BACK, hiddenLines, filterReply, tryView } from './views';

const core = {
  exercise: 'state-easy-1',
  passed: 2,
  total: 4,
  recorded: true,
  tests: [
    { name: 'shows zero', status: 'pass' as const },
    { name: 'adds one', status: 'fail' as const, message: 'expected 1', actual: 'Count: 0' },
    { name: 'hidden #1', status: 'pass' as const },
    { name: 'hidden #2', status: 'fail' as const },
  ],
};

describe('views (§2.2, D4)', () => {
  it('reduces hidden results to an index and a status', () => {
    expect(checkView(core, { stuck: false, mastered: false })).toEqual({
      kind: 'graded',
      passed: 2,
      total: 4,
      recorded: true,
      stuck: false,
      mastered: false,
      tests: [
        { hidden: false, name: 'shows zero', status: 'pass' },
        { hidden: false, name: 'adds one', status: 'fail', message: 'expected 1', actual: 'Count: 0' },
        { hidden: true, index: 1, status: 'pass' },
        { hidden: true, index: 2, status: 'fail' },
      ],
    });
  });

  it('never forwards a hidden result even if core named it differently', () => {
    const view = checkView({ ...core, tests: [{ name: 'hidden #1', status: 'fail', message: 'secret', actual: 'secret' }] }, { stuck: false, mastered: false });
    expect(JSON.stringify(view)).not.toContain('secret');
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
    const material = hiddenLines({
      'solution/main.c': 'int main() {\n  printf("the hidden canary answer %d", 42);\n  return 0;\n}\n',
      'tests/hidden/1.in': 'short\n',
      'README.md': '# Not hidden\nprintf("the visible statement line is fine");\n',
    }, { 'hidden/1': 'expected hidden output canary line' });
    expect(material).toContain('printf("the hidden canary answer %d", 42);');
    expect(material).not.toContain('short');
    expect(material.some((l) => l.includes('visible statement'))).toBe(false);
    expect(filterReply('Try:\n```\n   printf("the hidden canary   answer %d", 42);\n```', material)).toBe(HELD_BACK);
    expect(filterReply('It should print expected hidden output canary line.', material)).toBe(HELD_BACK);
    expect(filterReply('Look at what you pass to printf.', material)).toBe('Look at what you pass to printf.');
  });
});
