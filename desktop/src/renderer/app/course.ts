import type { CourseView } from '../../shared/api';

/**
 * Whether a course screen can stop re-reading Codemm: nothing is installing, and setup and the
 * current topic's lessons and activity are written, or that agent work stopped (§5).
 */
export function settled(c: CourseView | null): boolean {
  if (!c) return true;
  if (c.setup === 'installing') return false;
  if (c.stalled) return true;
  if (c.setup === 'proposing') return false;
  return !c.topics.some((t) => t.state === 'now' && (t.lessons.some((l) => l.state === 'writing') || (c.setup === 'ready' && t.activity === 'writing')));
}
