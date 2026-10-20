import type { HLJSApi } from 'highlight.js';

/** The editor colors on each keystroke, so longer code stays plain (§4.10): 32 KB takes about one frame. */
export const MAX_COLORED = 32 * 1024;

let loading: Promise<HLJSApi | undefined> | undefined;
let ready: HLJSApi | undefined;
/** highlight.js's common build, in its own chunk, loaded once with the first editor or lesson that has code to color. */
export const highlighter = () => (loading ??= import('highlight.js/lib/common').then((m) => (ready = m.default), () => undefined));
/** highlight.js once it has loaded, so a screen opened later shows its colors on its first paint. */
export const loadedHighlighter = () => ready;

/** What the editor asks highlight.js about: the file's extension, or its name when it has none. */
export function nameOf(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * The code as highlight.js colors it, when it knows `name` (a file's extension, a fence's info string) as one of its
 * languages or their aliases: the code escaped, with class names only. Codemm names no language; anything else stays
 * plain (undefined).
 */
export function colorize(hljs: HLJSApi, name: string, text: string): string | undefined {
  if (text.length > MAX_COLORED || !hljs.getLanguage(name)) return undefined;
  return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
}
