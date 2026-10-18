import type { CheckResult, FinishedTest, TestView, TryResult, VisibleTest } from '../../../shared/api';
import type { TerminalHandle } from '../../ui/Terminal';

/** The core names visible results "visible/<name>"; the exercise names its tests "<name>". */
export const testName = (name: string) => name.replace(/^visible\//, '');
/** "visible/01" is shown as "test 01". */
const label = (name: string) => `test ${testName(name)}`;
const trimEnd = (text: string) => text.replace(/\n+$/, '');
/** A value under its label, later lines lined up with the first. */
const labelled = (name: string, text: string) => `  ${name.padEnd(10)}${trimEnd(text).split('\n').join(`\n${' '.repeat(12)}`)}`;

function verdict(term: TerminalHandle, test: Pick<FinishedTest, 'name' | 'status' | 'message' | 'actual'>, visible: VisibleTest[]) {
  if (test.status === 'pass') return term.line(`✓ ${label(test.name)}`, 'ok');
  if (test.status === 'error') return term.line(`✗ ${label(test.name)}: ${test.message ?? 'Error'}`, 'fail');
  const expected = visible.find((v) => `visible/${v.name}` === test.name)?.expected ?? '';
  term.line(`✗ ${label(test.name)}`, 'fail');
  term.line(labelled('expected', expected), 'quiet');
  term.line(labelled('found', test.actual || '(no output)'), 'quiet');
}

/** One visible test as it finishes: the command, what the program printed, then ✓ or ✗ with expected and found. */
export function printTest(term: TerminalHandle, command: string, test: Pick<FinishedTest, 'name' | 'status' | 'message' | 'actual'>, visible: VisibleTest[]) {
  term.command(`${command}  (${label(test.name)})`);
  if (test.actual) term.write(test.actual);
  verdict(term, test, visible);
}

/**
 * Visible tests that didn't stream, printed from the final result as streaming would have. Their events can land
 * after the reply, or never come (the build failed). A passing test's output isn't in the final result.
 */
function unstreamed(term: TerminalHandle, command: string, tests: TestView[], streamed: Set<string>, visible: VisibleTest[]) {
  for (const t of tests) if (!t.hidden && !streamed.has(t.name)) printTest(term, command, t, visible);
}

/** Try it's last lines: the summary of the visible tests. */
export function printTry(term: TerminalHandle, command: string, result: TryResult, streamed: Set<string>, visible: VisibleTest[]) {
  if (result.kind === 'not-counted') return term.line(result.reason, 'fail');
  unstreamed(term, command, result.tests, streamed, visible);
  const all = result.passed === result.total;
  term.line(`${all ? '✓' : '✗'} ${result.passed} of ${result.total} visible tests passed`, all ? 'ok' : 'fail');
}

/** Check's last lines: hidden tests as an index and a status only, then the summary. */
export function printCheck(term: TerminalHandle, command: string, result: CheckResult, streamed: Set<string>, visible: VisibleTest[]) {
  if (result.kind === 'not-counted') return term.line(result.reason, 'fail');
  unstreamed(term, command, result.tests, streamed, visible);
  for (const t of result.tests) if (t.hidden) term.line(`hidden #${t.index} ${t.status === 'pass' ? '✓' : '✗'}`, t.status === 'pass' ? 'ok' : 'fail');
  const all = result.passed === result.total;
  term.line(`${all ? '✓' : '✗'} ${result.passed} of ${result.total} passed`, all ? 'ok' : 'fail');
}
