// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CoreProgress } from './core/types';
import { courseView, otherReady, type Setup } from './courseView';

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
    expect(view).toMatchObject({ goal: 'React', track: 'React', setup: 'ready', done: false });
  });

  it('keeps the activity locked until the lessons are read, and shows a lesson being written', () => {
    const unread = courseView(progress({ kind: 'practice', exercise: 'e', concept: 'state', lesson: 'state-1' }), [{ id: 'state-1', concept: 'state', title: 'What state is', read: false }], ready, new Set());
    expect(unread.topics[1]).toMatchObject({ activity: 'locked', lessons: [{ state: 'ready' }] });
    const writing = courseView(progress({ kind: 'author', concept: 'state', difficulty: 1, lesson: null }), [], ready, new Set(['lesson:state']));
    expect(writing.topics[1]).toMatchObject({ activity: 'writing', lessons: [{ state: 'writing' }] });
  });

  it('shows a due review on its mastered topic, and when the next review is due elsewhere', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const withDue = concepts.map((c) => (c.id === 'values' ? { ...c, reviewDue: '2026-10-23T09:00:00Z' } : c));
    const at = (next: CoreProgress['next']) => courseView({ ...progress(next), concepts: withDue }, [], ready, new Set(), now);
    expect(at({ kind: 'practice', exercise: 'e', concept: 'state' }).topics[0]).toMatchObject({ state: 'mastered', activity: 'passed', reviewIn: 3 });
    expect(at({ kind: 'review', concept: 'values', difficulty: 2, exercise: 'v-9' }).topics[0]).toMatchObject({ state: 'mastered', activity: 'open', review: 'due' });
    expect(at({ kind: 'author', concept: 'values', difficulty: 2, review: true }).topics[0]).toMatchObject({ activity: 'writing', review: 'writing' });
  });

  it('counts down only to future reviews: an overdue one waiting its turn shows no countdown', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const both = concepts.map((c) => (c.id === 'values' ? { ...c, reviewDue: '2026-10-19T09:00:00Z' } : c.id === 'forms' ? { ...c, mastered: true, reviewDue: '2026-10-18T09:00:00Z' } : c));
    const view = courseView({ ...progress({ kind: 'review', concept: 'forms', difficulty: 1, exercise: 'f-2' }), concepts: both }, [], ready, new Set(), now);
    expect(view.topics[0]).not.toHaveProperty('reviewIn');
    expect(view.topics[0]).not.toHaveProperty('review');
    expect(view.topics[2]).toMatchObject({ review: 'due' });
  });

  it('carries the setup state and proposal, and is done when every concept is mastered', () => {
    const consent = courseView(progress({ kind: 'setup', track: 'react@1' }), [], { state: 'consent', proposal: { digest: 'd'.repeat(64), retry: false, files: [] } }, new Set());
    expect(consent).toMatchObject({ setup: 'consent', proposal: { digest: 'd'.repeat(64) } });
    expect(consent.topics.every((t) => t.activity !== 'open')).toBe(true);
    expect(courseView(progress({ kind: 'done' }), [], { state: 'failed', problem: 'disk' }, new Set())).toMatchObject({ done: true, setup: 'failed', setupProblem: 'disk' });
  });

  it('during setup, the current topic is the first one ready to learn, and a failed setup keeps its proposal', () => {
    const proposal = { digest: 'd'.repeat(64), retry: false, files: [] };
    const view = courseView(progress({ kind: 'setup', track: 'react@1' }), [], { state: 'failed', problem: 'docker', proposal }, new Set(['lesson:state']));
    expect(view.topics[1]).toMatchObject({ id: 'state', state: 'now', activity: 'writing', lessons: [{ state: 'writing' }] });
    expect(view).toMatchObject({ setup: 'failed', setupProblem: 'docker', proposal });
  });

  it('keeps a stuck activity open', () => {
    expect(courseView(progress({ kind: 'stuck', concept: 'state' }), [], ready, new Set()).topics[1]).toMatchObject({ state: 'now', activity: 'open' });
  });
});

describe('another topic ready', () => {
  it('is true only when a topic besides these is not mastered and has its prerequisites mastered', () => {
    expect(otherReady(progress({ kind: 'stuck', concept: 'state' }), ['state'])).toBe(true);
    const linear = { ...progress({ kind: 'stuck', concept: 'state' }), concepts: concepts.filter((c) => c.id !== 'forms') };
    expect(otherReady(linear, ['state'])).toBe(false);
  });
});
