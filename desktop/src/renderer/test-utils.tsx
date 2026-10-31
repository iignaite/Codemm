import { render } from '@testing-library/react';
import type { CodemmApi, CourseView, JobProgress, Roadmap } from '../shared/api';
import { createMock, type MockOptions } from '../main/mock';
import { App } from './app/App';
import type { Route } from './app/router';

/** `strict` renders under StrictMode, as the app's root does, which replays every effect once. */
export function renderApp(start: Route = { to: 'welcome' }, api: CodemmApi = createMock(), { strict = false } = {}) {
  return { api, ...render(<App api={api} start={start} />, { reactStrictMode: strict }) };
}

/** A connected mock with a researched roadmap. */
export async function mockWithRoadmap(options?: MockOptions): Promise<{ api: CodemmApi; roadmap: Roadmap }> {
  const api = createMock(options);
  await api.connect('claude');
  const goal = { topic: 'React', known: '', depth: 'standard' as const, practice: 'code' as const };
  let r = await api.research(goal);
  while (r.state === 'running') r = await api.research(goal);
  return { api, roadmap: r.roadmap! };
}

/** The course once `done` holds, reading it again (which moves the mock's jobs along) a few times at most. */
export async function until(api: CodemmApi, done: (c: CourseView) => boolean): Promise<CourseView> {
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

/** Jobs a test tells the app about: every subscriber hears them, and a screen that opens meanwhile reads the running ones. */
export function jobBus(api: CodemmApi) {
  const listeners = new Set<(p: JobProgress) => void>();
  let running: JobProgress[] = [];
  api.onJobProgress = (listener) => (listeners.add(listener), () => void listeners.delete(listener));
  api.jobProgress = async () => running;
  return (p: JobProgress) => {
    running = p.ended ? running.filter((r) => r.job !== p.job) : [...running.filter((r) => r.job !== p.job), p];
    listeners.forEach((l) => l(p));
  };
}

/** A running job's report, with the fields a test doesn't care about filled in. */
export const jobAt = (job: string, kind: JobProgress['kind'], over: Partial<JobProgress> = {}): JobProgress => ({ job, kind, stage: 1, steps: [], count: 0, thinking: true, elapsedMs: 0, idleMs: 0, ...over });
