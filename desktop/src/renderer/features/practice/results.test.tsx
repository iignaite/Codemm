import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { REBUILD } from '../../../shared/api';
import type { CoreCheckView } from '../../../main/core/types';
import { checkView, tryView } from '../../../main/views';
import { Results, type Ways } from './Results';

// Real core shapes (src/app.ts): results name visible tests "visible/<name>" and hidden ones
// "hidden #<n>", while the exercise lists its visible io tests by bare name.
const core: CoreCheckView = {
  exercise: 'count-1',
  passed: 1,
  total: 3,
  recorded: true,
  tests: [
    { name: 'visible/01', status: 'pass' },
    { name: 'visible/02', status: 'fail', actual: 'Count: 0' },
    { name: 'hidden #1', status: 'fail' },
  ],
};
const visibleTests = [
  { name: '01', input: '', expected: 'Count: 0' },
  { name: '02', input: 'click', expected: 'Count: 1' },
];
const ways: Ways = { retry() {}, keepTrying() {}, reread() {}, easier() {}, later() {}, computer() {}, tracks() {}, next() {} };

function results() {
  return screen.getByRole('region', { name: 'Results' });
}

describe('Results with real core result shapes', () => {
  it('shows expected next to found for a failed visible io test after Check', () => {
    render(<Results shown={{ kind: 'check', result: checkView(core, { stuck: false, mastered: false, later: true }), keepTrying: false }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('expected Count: 1');
    expect(results()).toHaveTextContent('found Count: 0');
  });

  it('promises no outcome when every test passed but the topic is not mastered yet', () => {
    const passed: CoreCheckView = { ...core, passed: 3, tests: core.tests.map((t) => ({ name: t.name, status: 'pass' as const })) };
    render(<Results shown={{ kind: 'check', result: checkView(passed, { stuck: false, mastered: false, later: true }), keepTrying: false }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('Keep practicing State.');
    expect(results()).not.toHaveTextContent('masters');
  });

  it('shows expected next to found after Try it', () => {
    render(<Results shown={{ kind: 'try', result: tryView(core) }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('expected Count: 1');
  });

  it("shows an error's message, not expected and found, even when the program printed nothing", () => {
    // Core's shape for a program that exits non-zero (src/grading.ts): the reason in message, stdout in actual.
    const crashed: CoreCheckView = { ...core, tests: [{ name: 'visible/02', status: 'error', message: 'Exited with code 1: SyntaxError: missing ) after argument list', actual: '' }] };
    render(<Results shown={{ kind: 'try', result: tryView(crashed) }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('Exited with code 1: SyntaxError: missing ) after argument list');
    expect(results()).not.toHaveTextContent('found');
    expect(results()).not.toHaveTextContent('expected');
  });

  it("keeps an error's lines, so a traceback's caret still points at the mistake", () => {
    // The real stylesheet (tests run from desktop/), so the computed style is the one the window uses.
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync(resolve('src/renderer/styles/app.css'), 'utf8');
    document.head.append(sheet);
    const traceback = 'Exited with code 1:\n  File "main.py", line 3\n    print("Hello, " + name\n                     ^\nSyntaxError: \'(\' was never closed';
    const crashed: CoreCheckView = { ...core, tests: [{ name: 'visible/02', status: 'error', message: traceback, actual: '' }] };
    render(<Results shown={{ kind: 'try', result: tryView(crashed) }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    const reason = within(results()).getByText((_, el) => el?.textContent === traceback && el.tagName === 'SPAN' && el.children.length === 0);
    expect(getComputedStyle(reason).whiteSpace).toBe('pre-wrap');
    sheet.remove();
  });

  it('says a wrong answer printed nothing, rather than an empty found', () => {
    const silent: CoreCheckView = { ...core, tests: [{ name: 'visible/02', status: 'fail', actual: '' }] };
    render(<Results shown={{ kind: 'try', result: tryView(silent) }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('found (no output)');
  });

  it('brings a finished Check into view, at once with reduced motion', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }));
    try {
      const view = render(<Results shown={{ kind: 'busy', label: 'Checking' }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
      expect(scroll).not.toHaveBeenCalled();
      view.rerender(<Results shown={{ kind: 'check', result: checkView(core, { stuck: false, mastered: false, later: true }), keepTrying: false }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
    } finally {
      vi.unstubAllGlobals();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('names tests by the name the exercise uses, without the set prefix', () => {
    render(<Results shown={{ kind: 'try', result: tryView(core) }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).not.toHaveTextContent('visible/');
    expect(results()).toHaveTextContent('02');
  });
});

describe('not counted', () => {
  it('sends a rebuild to Tracks, and anything else to Check this computer', () => {
    const view = render(<Results shown={{ kind: 'check', result: { kind: 'not-counted', reason: REBUILD }, keepTrying: false }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(screen.getByRole('button', { name: 'Go to Tracks' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check this computer' })).not.toBeInTheDocument();
    view.unmount();
    render(<Results shown={{ kind: 'check', result: { kind: 'not-counted', reason: "Docker isn't running." }, keepTrying: false }} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(screen.getByRole('button', { name: 'Check this computer' })).toBeInTheDocument();
  });
});

describe('stuck', () => {
  const stuck = (later: boolean) => ({ kind: 'check' as const, result: { ...checkView(core, { stuck: true, mastered: false, later }) }, keepTrying: false });

  it('offers Come back later only when another topic can come next', () => {
    const view = render(<Results shown={stuck(false)} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(screen.getByRole('button', { name: 'Reread the lesson' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Come back later' })).not.toBeInTheDocument();
    view.unmount();
    render(<Results shown={stuck(true)} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(screen.getByRole('button', { name: 'Come back later' })).toBeInTheDocument();
  });

  it('keeps the failed results under the ways forward', () => {
    render(<Results shown={stuck(true)} name="Emm" topic="State" visibleTests={visibleTests} ways={ways} />);
    expect(results()).toHaveTextContent('1 of 3 passed');
    expect(results()).toHaveTextContent('expected Count: 1');
    expect(screen.getByRole('img', { name: 'Hidden test 1 not yet' })).toBeInTheDocument();
  });
});
