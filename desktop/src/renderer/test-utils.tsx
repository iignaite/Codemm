import { render } from '@testing-library/react';
import type { CodemmApi } from '../shared/api';
import { createMock, type MockOptions } from '../main/mock';
import { App } from './app/App';
import type { Route } from './app/router';

export function renderApp(start: Route = { to: 'welcome' }, api: CodemmApi = createMock()) {
  return { api, ...render(<App api={api} start={start} />) };
}

/** A mock with a course approved and set up, and its first lessons read. */
export async function mockWithCourse(options?: MockOptions & { read?: boolean }) {
  const api = createMock(options);
  const goal = { topic: 'React', known: [] };
  let r = await api.research(goal);
  while (!r.done) r = await api.research(goal);
  await api.approve({ title: r.title, track: r.track, installed: r.installed, topics: r.path.map((s) => s.title) });
  let course = (await api.course())!;
  for (let i = 0; i < 5; i++) course = (await api.course())!;
  if (options?.read) for (const l of course.topics[0].lessons) await api.read(l.id);
  return { api, course: (await api.course())! };
}
