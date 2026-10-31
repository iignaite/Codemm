// Every renderer call passes through here: the method must be part of
// CodemmApi and every argument must have the right shape before Codemm sees it.
import type { CodemmApi } from '../shared/api';
import { errorFields, safeError, SafeError } from './errors';
import type { Log } from './log';
import { LIMITS } from '../shared/limits';

type Valid = (value: unknown) => boolean;

const MAX_FILE_BYTES = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (max: number, min = 0): Valid => (v) => typeof v === 'string' && v.length >= min && v.length <= max;
const oneOf = (...options: string[]): Valid => (v) => typeof v === 'string' && options.includes(v);
/** Core's ids: lowercase, at most 64 characters (docs/DESIGN.md §3). */
const id: Valid = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v) && !v.includes('..');
/** A track `id@version`, as core's ids. */
const trackRef: Valid = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}@[1-9][0-9]{0,8}$/.test(v);
/** A dense array (no holes, which `every` would skip) of valid items. */
const list = (item: Valid, max: number, min = 0): Valid => (v) =>
  Array.isArray(v) && v.length >= min && v.length <= max && Object.keys(v).length === v.length && v.every(item);
const shape = (fields: Record<string, Valid>): Valid => (v) =>
  isObject(v) && Object.keys(v).every((k) => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, valid]) => valid(v[k]));

/**
 * A relative, `/`-separated path with no `.` or `..` parts, as in core's file
 * maps, that is also safe on Windows: no reserved characters, device names,
 * or names ending in a dot or space.
 */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const part: Valid = (p) =>
  typeof p === 'string' && p !== '' && p !== '.' && p !== '..' && !/[<>:"|?*\\\u0000-\u001f]/.test(p) && !DEVICE.test(p) && !/[. ]$/.test(p);
const path: Valid = (v) => typeof v === 'string' && v.length <= 512 && v.split('/').every(part);

/** The renderer's id for one Try it, Check or Run, echoed in its events. */
const runId: Valid = (v) => typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v);
const digest: Valid = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const goal = shape({ topic: text(LIMITS.topic, 1), known: text(LIMITS.known), depth: oneOf('overview', 'standard', 'in-depth'), practice: oneOf('code', 'quiz', 'none') });
const concept = shape({ id, title: text(LIMITS.title, 1), requires: list(id, 200) });
const concepts = list(concept, 200, 1);
const place: Valid = (v) => shape({ lessonId: id })(v) || shape({ activityId: id })(v);
const words = text(LIMITS.words, 1);
/** A lesson example's number: core keeps at most 5. */
const exampleNumber: Valid = (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
const fileText: Valid = (v) => typeof v === 'string' && new TextEncoder().encode(v).length <= MAX_FILE_BYTES;

// onCheckProgress, onJobProgress and onRunOutput are events main sends, never something the renderer may call.
const ARGS: { [K in Exclude<keyof CodemmApi, 'onCheckProgress' | 'onJobProgress' | 'onRunOutput'>]: Valid[] } = {
  agents: [],
  jobProgress: [],
  connect: [oneOf('claude', 'codex', 'cursor')],
  chooseModel: [oneOf('claude', 'codex', 'cursor'), text(64, 1)],
  installAgent: [oneOf('claude', 'codex', 'cursor')],
  signIn: [oneOf('claude', 'codex', 'cursor')],
  computer: [],
  installDocker: [],
  openDocker: [],
  openWindowsUpdate: [],
  restartWindows: [],
  tracks: [],
  research: [goal],
  reviseRoadmap: [concepts, words],
  approve: [concepts],
  draft: [],
  saveDraft: [concepts],
  course: [],
  courses: [],
  switchCourse: [id],
  setActivities: [(v) => typeof v === 'boolean'],
  install: [digest],
  retrySetup: [],
  retryJobs: [],
  lesson: [id],
  saveNotes: [id, text(LIMITS.note)],
  markRead: [id],
  activity: [id],
  saveFile: [id, path, fileText, digest],
  tryIt: [id, runId],
  runExample: [id, exampleNumber],
  runExampleLive: [id, exampleNumber, runId],
  check: [id, runId],
  runProgram: [id, runId],
  sendRunInput: [runId, text(64 * 1024, 1)],
  endRunInput: [runId],
  stopRun: [runId],
  ask: [place, words],
  skip: [id],
  easier: [id],
  rebuild: [trackRef],
  usage: [],
  update: [],
  restartToUpdate: [],
};

/** Validates a renderer call and passes it to Codemm. Throws on anything unexpected. */
export function dispatch(codemm: CodemmApi, method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !Object.hasOwn(ARGS, method)) throw new SafeError('Unknown call');
  const valid = ARGS[method as keyof typeof ARGS];
  if (!Array.isArray(args) || args.length !== valid.length || !valid.every((check, i) => check(args[i]))) throw new SafeError('Bad input');
  const call = codemm[method as keyof typeof ARGS] as (...a: unknown[]) => Promise<unknown>;
  return call.apply(codemm, args);
}

/**
 * The `codemm` IPC handler: calls only from the app's own frame, validated, and
 * failures reduced to what may leave main (errors.ts), with structured logging.
 */
export function handler<E>(codemm: CodemmApi, log: Log, fromApp: (event: E) => boolean) {
  return (event: E, method: unknown, args: unknown): Promise<unknown> =>
    Promise.resolve()
      .then(() => {
        if (!fromApp(event)) throw new SafeError('Unknown sender');
        return dispatch(codemm, method, args);
      })
      .catch((e: unknown) => {
        log('ipc-error', { method: typeof method === 'string' && Object.hasOwn(ARGS, method) ? method : 'unknown', ...errorFields(e) });
        throw safeError(e);
      });
}
