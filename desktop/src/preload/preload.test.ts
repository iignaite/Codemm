// @vitest-environment node
// The preload is the only door for main's events: a kind or field it doesn't know never reaches the window, and the
// mock, which skips it, can't show that. So it is tested here, with Electron's two objects faked.
import { describe, expect, it, vi } from 'vitest';
import type { Bridge, JobProgress } from '../shared/api';
import { JOB_STAGES } from '../shared/progress';

const door = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload: unknown) => void>(), bridge: undefined as unknown }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => void (door.bridge = api) },
  ipcRenderer: {
    invoke: vi.fn(),
    on: (channel: string, fn: (event: unknown, payload: unknown) => void) => void door.handlers.set(channel, fn),
    removeListener: (channel: string) => void door.handlers.delete(channel),
  },
}));

const report = (over: Record<string, unknown>) => ({ job: 'j1', kind: 'lesson', stage: 1, steps: [], count: 0, thinking: true, elapsedMs: 5, idleMs: 0, ...over });

async function heardFrom(...sent: Record<string, unknown>[]): Promise<JobProgress[]> {
  await import('./preload');
  const heard: JobProgress[] = [];
  (door.bridge as Bridge).onJobProgress((p) => heard.push(p));
  for (const p of sent) door.handlers.get('codemm:job-progress')!({}, p);
  return heard;
}

describe('preload: job progress (§4.11)', () => {
  it('lets every kind of job through, a rebuild with its track name', async () => {
    const kinds = Object.keys(JOB_STAGES);
    expect(kinds).toContain('rebuild');
    expect(kinds).toContain('review');
    const heard = await heardFrom(...kinds.map((kind) => report({ kind })), report({ kind: 'rebuild', track: 'Python', job: 'j2' }));
    expect(heard.map((p) => p.kind)).toEqual([...kinds, 'rebuild']);
    expect(heard.at(-1)).toMatchObject({ job: 'j2', kind: 'rebuild', track: 'Python' });
  });

  it('drops a kind it does not know, and anything but plain fields', async () => {
    const heard = await heardFrom(report({ kind: 'mystery' }), report({ track: { name: 'x' }, extra: '/Users/me/secret' }));
    expect(heard).toEqual([{ job: 'j1', kind: 'lesson', stage: 1, steps: [], count: 0, thinking: true, elapsedMs: 5, idleMs: 0 }]);
  });
});
