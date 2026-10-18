import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../shared/api';
import { dispatch } from './ipc';

// Every call resolves to its method name and arguments, so a test can see what got through.
const echo = new Proxy({} as CodemmApi, { get: (_t, method) => async (...args: unknown[]) => ({ method, args }) });

const concepts = [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }];
const GOOD: Record<Exclude<keyof CodemmApi, 'onCheckProgress' | 'onResearchProgress'>, unknown[]> = {
  agents: [],
  connect: ['claude'],
  chooseModel: ['claude', 'opus'],
  computer: [],
  tracks: [],
  research: [{ topic: 'React', known: 'Python', depth: 'standard' }],
  reviseRoadmap: [concepts, 'Add testing'],
  approve: [concepts],
  course: [],
  install: ['a'.repeat(64)],
  retrySetup: [],
  retryJobs: [],
  lesson: ['values-1'],
  saveNotes: ['values-1', 'A note'],
  markRead: ['values-1'],
  activity: ['values'],
  saveFile: ['values-easy-1', 'src/Counter.jsx', 'x', 'b'.repeat(64)],
  tryIt: ['values-easy-1', 'run-1'],
  check: ['values-easy-1', 'run-1'],
  ask: [{ activityId: 'values-easy-1' }, 'Why?'],
  skip: ['values'],
  easier: ['values'],
  rebuild: ['react@1'],
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
    expect(() => dispatch(echo, 'connect', ['gemini'])).toThrow('Bad input');
    expect(() => dispatch(echo, 'saveNotes', ['values-1', 'x'.repeat(20_001)])).toThrow('Bad input');
    expect(() => dispatch(echo, 'ask', [{ activityId: 'a' }, ''])).toThrow('Bad input');
    expect(() => dispatch(echo, 'ask', [{ lessonId: 'a', activityId: 'b' }, 'Why?'])).toThrow('Bad input');
    expect(() => dispatch(echo, 'install', ['not-a-digest'])).toThrow('Bad input');
  });

  it('rejects goals and roadmaps with the wrong shape', () => {
    expect(() => dispatch(echo, 'research', [{ topic: '', known: '', depth: 'standard' }])).toThrow('Bad input');
    // How deep the roadmap goes: one of three presets, always given.
    for (const depth of ['overview', 'standard', 'in-depth']) expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '', depth }])).not.toThrow();
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '', depth: 'bottomless' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '', extra: 1 }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '', constructor: 1 }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'research', [{ topic: 'React', known: '', toString: 'x' }])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[]])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [new Array(1)])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[{ id: 'Values', title: 'V', requires: [] }]])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[{ id: 'a'.repeat(65), title: 'V', requires: [] }]])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[{ id: 'a', title: '', requires: [] }]])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[{ id: 'a', title: 'A', requires: ['../x'] }]])).toThrow('Bad input');
    expect(() => dispatch(echo, 'approve', [[{ id: 'a', title: 'A' }]])).toThrow('Bad input');
  });

  it('rejects file paths that could escape the workspace or are unsafe on Windows', () => {
    const bad = ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'C:/x', 'a\u0000b', 'src/file:stream', 'what?.txt', 'NUL', 'src/con.txt', 'Com1', 'notes.', 'notes ', ''];
    for (const path of bad) expect(() => dispatch(echo, 'saveFile', ['a', path, '', 'b'.repeat(64)])).toThrow('Bad input');
    expect(() => dispatch(echo, 'saveFile', ['a', 'big', 'x'.repeat(1_048_577), 'b'.repeat(64)])).toThrow('Bad input');
  });
});
