import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../shared/api';
import { dispatch } from './ipc';

// Every call resolves to its method name and arguments, so a test can see what got through.
const echo = new Proxy({} as CodemmApi, { get: (_t, method) => async (...args: unknown[]) => ({ method, args }) });

const files = [{ path: 'src/Counter.jsx', text: 'x' }];
const draft = { title: 'React basics', track: 'React', installed: false, topics: ['State'] };
const GOOD: Record<keyof CodemmApi, unknown[]> = {
  agents: [],
  connect: ['claude'],
  suggestions: [],
  computer: [],
  research: [{ topic: 'React', known: ['Python'] }],
  revise: [draft, 'Add testing'],
  approve: [draft],
  setUp: [],
  course: [],
  lesson: ['t1.1'],
  read: ['t1.1'],
  saveNote: ['t1.1', 'A note'],
  activity: ['t1.a'],
  save: ['t1.a', files],
  run: ['t1.a', files],
  check: ['t1.a', files],
  help: ['t1.a', 'hint'],
  ask: [{ activityId: 't1.a' }, 'Why?'],
  assist: ['t1.a', true],
  easier: ['t1.a'],
  tracks: [],
  rebuild: ['react'],
};

describe('dispatch', () => {
  it('passes every valid call through to Codemm', async () => {
    for (const [method, args] of Object.entries(GOOD)) {
      expect(await dispatch(echo, method, args)).toEqual({ method, args });
    }
  });

  it('rejects unknown methods and malformed calls', () => {
    for (const method of ['nope', 'constructor', '__proto__', 'toString', 42]) {
      expect(() => dispatch(echo, method, [])).toThrow('Unknown call');
    }
    expect(() => dispatch(echo, 'lesson', 't1.1')).toThrow('Bad input');
    expect(() => dispatch(echo, 'lesson', [])).toThrow('Bad input');
    expect(() => dispatch(echo, 'lesson', ['t1.1', 'extra'])).toThrow('Bad input');
    expect(() => dispatch(echo, 'agents', ['extra'])).toThrow('Bad input');
  });

  it('rejects bad ids, text and choices', () => {
    for (const id of ['', '../t1', 't1/../../x', 'a'.repeat(200), 7, null]) {
      expect(() => dispatch(echo, 'lesson', [id])).toThrow('Bad input');
    }
    expect(() => dispatch(echo, 'saveNote', ['t1.1', 'x'.repeat(20_001)])).toThrow('Bad input');
    expect(() => dispatch(echo, 'ask', [{ activityId: 't1.a' }, ''])).toThrow('Bad input');
    expect(() => dispatch(echo, 'ask', [{ lessonId: 't1.1', activityId: 't1.a' }, 'Why?'])).toThrow('Bad input');
    expect(() => dispatch(echo, 'help', ['t1.a', 'solve'])).toThrow('Bad input');
    expect(() => dispatch(echo, 'assist', ['t1.a', 'yes'])).toThrow('Bad input');
  });

  it('rejects goals and drafts with the wrong shape', () => {
    expect(() => dispatch(echo, 'research', [{ topic: '', known: [] }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: [], extra: 1 }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: [], constructor: 1 }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: [], toString: 'x' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [{ ...draft, topics: [] }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [{ ...draft, topics: [''] }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [{ ...draft, installed: 'no' }])).toThrow('Bad input');
  });

  it('rejects file maps that could escape the workspace or are too big', () => {
    const bad = [
      [{ path: '/etc/passwd', text: '' }],
      [{ path: '../x', text: '' }],
      [{ path: 'a/../../x', text: '' }],
      [{ path: 'a\\b', text: '' }],
      [{ path: 'C:/x', text: '' }],
      [{ path: 'a\u0000b', text: '' }],
      [{ path: 'src/file:stream', text: '' }],
      [{ path: 'what?.txt', text: '' }],
      [{ path: 'NUL', text: '' }],
      [{ path: 'src/con.txt', text: '' }],
      [{ path: 'Com1', text: '' }],
      [{ path: 'notes.', text: '' }],
      [{ path: 'notes ', text: '' }],
      [{ path: 'a', text: 1 }],
      [{ path: 'a', text: '', extra: true }],
      Array.from({ length: 257 }, (_, i) => ({ path: `f${i}`, text: '' })),
      [{ path: 'big', text: 'x'.repeat(1_048_577) }],
      'not files',
    ];
    for (const f of bad) expect(() => dispatch(echo, 'check', ['t1.a', f])).toThrow('Bad input');
  });
});
