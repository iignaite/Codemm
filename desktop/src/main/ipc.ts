// Every renderer call passes through here: the method must be part of
// CodemmApi and every argument must have the right shape before Codemm sees it.
import type { CodemmApi } from '../shared/api';

type Valid = (value: unknown) => boolean;

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (max: number, min = 0): Valid => (v) => typeof v === 'string' && v.length >= min && v.length <= max;
const bool: Valid = (v) => typeof v === 'boolean';
const oneOf = (...options: string[]): Valid => (v) => typeof v === 'string' && options.includes(v);
const id: Valid = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) && !v.includes('..');
const list = (item: Valid, max: number, min = 0): Valid => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(item);
const shape = (fields: Record<string, Valid>): Valid => (v) =>
  isObject(v) && Object.keys(v).every((k) => k in fields) && Object.entries(fields).every(([k, valid]) => valid(v[k]));

/** A relative, `/`-separated path with no `.` or `..` parts, as in core's file maps. */
const path: Valid = (v) =>
  typeof v === 'string' && v.length <= 512 && !v.startsWith('/') && !v.includes('\\') && !/^[A-Za-z]:/.test(v) &&
  v.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

const files: Valid = (v) =>
  list(shape({ path, text: text(MAX_FILE_BYTES) }), MAX_FILES)(v) &&
  (v as { text: string }[]).reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0) <= MAX_FILE_BYTES;

const topic = text(200, 1);
const goal = shape({ topic, known: list(text(100, 1), 20) });
const draft = shape({ title: topic, track: text(100, 1), installed: bool, topics: list(topic, 200, 1) });
const place: Valid = (v) => shape({ lessonId: id })(v) || shape({ activityId: id })(v);
const words = text(2000, 1);

const ARGS: { [K in keyof CodemmApi]: Valid[] } = {
  agents: [],
  connect: [id],
  suggestions: [],
  computer: [],
  research: [goal],
  revise: [draft, words],
  approve: [draft],
  setUp: [],
  course: [],
  lesson: [id],
  read: [id],
  saveNote: [id, text(20_000)],
  activity: [id],
  save: [id, files],
  run: [id, files],
  check: [id, files],
  help: [id, oneOf('hint', 'show')],
  ask: [place, words],
  assist: [id, bool],
  easier: [id],
  tracks: [],
  rebuild: [id],
};

/** Validates a renderer call and passes it to Codemm. Throws on anything unexpected. */
export function dispatch(codemm: CodemmApi, method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !Object.hasOwn(ARGS, method)) throw new Error('Unknown call');
  const valid = ARGS[method as keyof CodemmApi];
  if (!Array.isArray(args) || args.length !== valid.length || !valid.every((check, i) => check(args[i]))) throw new Error('Bad input');
  const call = codemm[method as keyof CodemmApi] as (...a: unknown[]) => Promise<unknown>;
  return call.apply(codemm, args);
}
