import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { CodemmApi, Course } from '../../shared/api';
import { createMockApi } from '../../main/mock';
import { ApiContext } from '../app/api';
import { NavContext, type Route } from '../app/nav';

export const settle = () => new Promise((r) => setTimeout(r, 5));

export function renderWith(ui: ReactElement, o: { api?: CodemmApi; route?: Route; courseId?: string } = {}) {
  const api = o.api ?? createMockApi({ delayMs: 0 });
  const go = vi.fn();
  const openCourse = vi.fn();
  const nav = { route: o.route ?? { to: 'welcome' as const }, go, courseId: o.courseId, openCourse };
  const user = userEvent.setup({ delay: null });
  render(
    <ApiContext.Provider value={api}>
      <NavContext.Provider value={nav}>{ui}</NavContext.Provider>
    </ApiContext.Provider>,
  );
  return { api, go, openCourse, user };
}

/** A React course whose setup finished, optionally with its first lessons read. */
export async function readyCourse(api: CodemmApi, o: { read?: boolean; needsSetup?: boolean } = {}): Promise<Course> {
  const { draft } = await api.research({ topic: 'React', known: [] });
  const course = await api.approveDraft({ ...draft, needsSetup: o.needsSetup ?? false });
  await settle();
  if (o.read) for (const l of (await api.getCourse(course.id)).topics[0].lessons) await api.openLesson(l.id);
  return api.getCourse(course.id);
}
