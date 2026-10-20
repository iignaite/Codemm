import type { CourseView, TopicView } from '../../shared/api';
import type { Route } from './router';

/** Where Continue takes a topic: its activity when it's open, otherwise its page (lessons first). */
export function continueRoute(topic: TopicView): Route {
  return topic.activity === 'open' ? { to: 'practice', concept: topic.id } : { to: 'topic', topicId: topic.id };
}

/** The topic Codemm offers now: a due (or being written) review, otherwise the current topic (§4.14). */
export const offeredTopic = (topics: TopicView[]) => topics.find((t) => t.review) ?? topics.find((t) => t.state === 'now');

/** When a mastered topic's next review comes, in days: never a date (§4.7). */
export const reviewText = (days: number) => (days === 1 ? 'Review tomorrow' : `Review in ${days} days`);

/**
 * Whether a course screen can stop re-reading Codemm: nothing is installing, and setup and the
 * current topic's lessons and activity are written, or that agent work stopped (§5).
 */
export function settled(c: CourseView | null): boolean {
  if (!c) return true;
  if (c.setup === 'installing') return false;
  if (c.stalled) return true;
  if (c.setup === 'proposing') return false;
  // A review is written on a mastered topic, so it counts as current work too.
  const current = (t: CourseView['topics'][number]) => t.state === 'now' || t.review !== undefined;
  return !c.topics.some((t) => current(t) && (t.lessons.some((l) => l.state === 'writing') || (c.setup === 'ready' && t.activity === 'writing')));
}
