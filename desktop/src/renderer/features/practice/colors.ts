import type { HLJSApi } from 'highlight.js';

/** Coloring runs on each keystroke, so a longer file stays plain (§4.10). */
export const MAX_COLORED = 64 * 1024;

let loading: Promise<HLJSApi | undefined> | undefined;
/** highlight.js's common build, in its own chunk, loaded once with the first editor. */
export const highlighter = () => (loading ??= import('highlight.js/lib/common').then((m) => m.default, () => undefined));

/** What highlight.js is asked about: the file's extension, or its name when it has none. */
export function nameOf(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * The file as highlight.js colors it, when it knows the file's extension as one of its languages or their aliases:
 * the code escaped, with class names only. Codemm names no language; anything else stays plain (undefined).
 */
export function colorize(hljs: HLJSApi, path: string, text: string): string | undefined {
  const language = nameOf(path);
  if (text.length > MAX_COLORED || !hljs.getLanguage(language)) return undefined;
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
