// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CoreProgress } from './core/types';
import { courseView, type Setup } from './courseView';

const concepts = [
  { id: 'values', title: 'Values', requires: [], mastery: 0.9, mastered: true, attempts: 2, stuck: false },
  { id: 'state', title: 'State', requires: ['values'], mastery: 0.5, mastered: false, attempts: 1, stuck: true },
  { id: 'forms', title: 'Forms', requires: [], mastery: 0.5, mastered: false, attempts: 0, stuck: false },
];
const progress = (next: CoreProgress['next']): CoreProgress => ({ course: 'react', goal: 'React', track: 'react@1', concepts, next });
const ready: Setup = { state: 'ready' };

describe('course view', () => {
  it('maps mastery, the current topic and its lessons', () => {
    const view = courseView(progress({ kind: 'practice', exercise: 'state-easy-1', concept: 'state' }), [
      { id: 'state-1', concept: 'state', title: 'What state is', read: true },
      { id: 'state-2', concept: 'state', title: 'useState', read: true },
    ], ready, new Set());
    expect(view.topics.map((t) => [t.id, t.state, t.activity])).toEqual([['values', 'mastered', 'passed'], ['state', 'now', 'open'], ['forms', 'later', 'locked']]);
    expect(view.topics[1]).toMatchObject({ stuck: true, mastery: 0.5, lessons: [{ id: 'state-1', title: 'What state is', state: 'read' }, { id: 'state-2', title: 'useState', state: 'read' }] });
    expect(view).toMatchObject({ goal: 'React', track: 'react', setup: 'ready', done: false });
  });

  it('keeps the activity locked until the lessons are read, and shows a lesson being written', () => {
    const unread = courseView(progress({ kind: 'practice', exercise: 'e', concept: 'state', lesson: 'state-1' }), [{ id: 'state-1', concept: 'state', title: 'What state is', read: false }], ready, new Set());
    expect(unread.topics[1]).toMatchObject({ activity: 'locked', lessons: [{ state: 'ready' }] });
    const writing = courseView(progress({ kind: 'author', concept: 'state', difficulty: 1, style: 'io', track: 'react@1', lesson: null }), [], ready, new Set(['lesson:state']));
    expect(writing.topics[1]).toMatchObject({ activity: 'writing', lessons: [{ state: 'writing' }] });
  });

  it('carries the setup state and proposal, and is done when every concept is mastered', () => {
    const consent = courseView(progress({ kind: 'setup', track: 'react@1' }), [], { state: 'consent', proposal: { digest: 'd'.repeat(64), retry: false, files: [] } }, new Set());
    expect(consent).toMatchObject({ setup: 'consent', proposal: { digest: 'd'.repeat(64) } });
    expect(consent.topics.every((t) => t.activity !== 'open')).toBe(true);
    expect(courseView(progress({ kind: 'done' }), [], { state: 'failed', problem: 'disk' }, new Set())).toMatchObject({ done: true, setup: 'failed', setupProblem: 'disk' });
  });
});
