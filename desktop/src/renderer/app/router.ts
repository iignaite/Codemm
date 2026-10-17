import { createContext, useContext } from 'react';
import type { Draft, Goal } from '../../shared/api';

export type Route =
  | { to: 'welcome' }
  | { to: 'connect' }
  | { to: 'goal' }
  | { to: 'research'; goal: Goal }
  | { to: 'course'; draft: Draft }
  | { to: 'topic'; topicId: string }
  | { to: 'lesson'; lessonId: string }
  | { to: 'practice'; activityId: string }
  | { to: 'learn' }
  | { to: 'tracks' };

export interface Router {
  route: Route;
  go: (route: Route) => void;
  /** Reports a failed call so the window can say so. */
  fail: (error: unknown) => void;
}

export const RouterContext = createContext<Router | null>(null);

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error('No router');
  return router;
}
