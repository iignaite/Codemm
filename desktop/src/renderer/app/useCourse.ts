import type { CourseView } from '../../shared/api';
import { useApi } from './api';
import { settled } from './course';
import { useLoad } from './useLoad';

/**
 * The course, re-read while Codemm is still working on it and whenever the window regains focus, as a course screen
 * needs: time alone can make a review due (core §7).
 */
export function useCourse(deps: unknown[] = []) {
  const api = useApi();
  return useLoad<CourseView | null>(() => api.course(), deps, { settled, onFocus: true });
}
