import { createContext, useContext } from 'react';
import type { Draft, Goal, Topic } from '../../shared/api';

export type Route =
  | { to: 'welcome' }
  | { to: 'connect' }
  | { to: 'ready' }
  | { to: 'goal' }
  | { to: 'research'; goal: Goal }
  | { to: 'draft'; draft: Draft }
  | { to: 'course' }
  | { to: 'topic'; topicId: string }
  | { to: 'lesson'; lessonId: string }
  | { to: 'practice'; exerciseId: string }
  | { to: 'tracks' };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
  courseId?: string;
  openCourse: (id: string) => void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNav needs a NavContext');
  return nav;
}

export const activityOpen = (topic: Topic) => !!topic.activity && topic.lessons.every((l) => l.state === 'read');

/** Where "Continue" goes for a topic: its activity once the lessons are read, otherwise its lessons. */
export const continueRoute = (topic: Topic): Route =>
  activityOpen(topic) ? { to: 'practice', exerciseId: topic.activity! } : { to: 'topic', topicId: topic.id };
