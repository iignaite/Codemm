import { createContext, useContext } from 'react';
import type { Draft, Goal } from '../../shared/api';

export type Route =
  | { to: 'welcome' }
  | { to: 'connect'; then?: Route }
  | { to: 'computer'; then: Route }
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
  /**
   * Reports a failed call. An agent that needs signing in opens connect, then
   * returns to `resume` (default: this route). Anything else is said in a banner.
   */
  fail: (error: unknown, resume?: Route) => void;
}

export const RouterContext = createContext<Router | null>(null);

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error('No router');
  return router;
}
