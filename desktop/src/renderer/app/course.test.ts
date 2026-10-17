import { describe, expect, it } from 'vitest';
import type { CourseView, TopicView } from '../../shared/api';
import { settled } from './course';

const topic = (over: Partial<TopicView> = {}): TopicView => ({ id: 'a', title: 'A', state: 'now', mastery: 0, stuck: false, lessons: [], activity: 'locked', ...over });
const course = (over: Partial<CourseView> = {}): CourseView => ({ goal: 'G', track: 't', setup: 'ready', topics: [topic()], done: false, ...over });

describe('settled', () => {
  it('keeps reading while setup or the current topic is being written, until that work stops', () => {
    expect(settled(null)).toBe(true);
    expect(settled(course())).toBe(true);
    expect(settled(course({ setup: 'proposing' }))).toBe(false);
    expect(settled(course({ topics: [topic({ lessons: [{ id: 'l', title: 'L', state: 'writing' }] })] }))).toBe(false);
    expect(settled(course({ topics: [topic({ activity: 'writing' })] }))).toBe(false);
    expect(settled(course({ setup: 'proposing', stalled: 'failed' }))).toBe(true);
  });

  it('keeps reading while a review is being written on a mastered topic', () => {
    expect(settled(course({ topics: [topic({ state: 'mastered', activity: 'writing', review: 'writing' })] }))).toBe(false);
    expect(settled(course({ topics: [topic({ state: 'mastered', activity: 'open', review: 'due' })] }))).toBe(true);
  });

  it('keeps reading while setup installs, even when other work stopped', () => {
    expect(settled(course({ setup: 'installing', stalled: 'failed' }))).toBe(false);
  });
});
