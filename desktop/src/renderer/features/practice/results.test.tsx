import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
