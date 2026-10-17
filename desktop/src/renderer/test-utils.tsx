import { render } from '@testing-library/react';
import type { CodemmApi, CourseView, Roadmap } from '../shared/api';
import { createMock, type MockOptions } from '../main/mock';
import { App } from './app/App';
import type { Route } from './app/router';

export function renderApp(start: Route = { to: 'welcome' }, api: CodemmApi = createMock()) {
  return { api, ...render(<App api={api} start={start} />) };
}

/** A connected mock with a researched roadmap. */
export async function mockWithRoadmap(options?: MockOptions): Promise<{ api: CodemmApi; roadmap: Roadmap }> {
  const api = createMock(options);
  await api.connect('claude');
  const goal = { topic: 'React', known: '' };
  let r = await api.research(goal);
  while (r.state === 'running') r = await api.research(goal);
  return { api, roadmap: r.roadmap! };
}

async function until(api: CodemmApi, done: (c: CourseView) => boolean): Promise<CourseView> {
  for (let i = 0; i < 10; i++) {
    const c = (await api.course())!;
    if (done(c)) return c;
  }
  throw new Error('course never settled');
}

/** A mock with a course approved and set up; `read` also reads the first topic's lessons. */
export async function mockWithCourse(options?: MockOptions & { read?: boolean }) {
  const { api, roadmap } = await mockWithRoadmap(options);
  await api.approve(roadmap.concepts);
  const { proposal } = await until(api, (c) => c.setup === 'consent');
  await api.install(proposal!.digest);
  const course = await until(api, (c) => c.setup === 'ready' && c.topics[0].lessons.every((l) => l.state !== 'writing'));
  if (options?.read) for (const l of course.topics[0].lessons) await api.markRead(l.id);
  return { api, course: (await api.course())! };
}
