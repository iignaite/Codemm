import { useEffect, useMemo, useState } from 'react';
import type { HLJSApi } from 'highlight.js';
import MarkdownIt from 'markdown-it';
import { colorize, highlighter, loadedHighlighter } from './colors';

// Agent-written text (lessons, statements, replies): raw HTML stripped, links only to
// https, and images shown as links so the page never loads anything remote
// (DESIGN §2.1).
const md = new MarkdownIt({ html: false, linkify: false });
md.validateLink = (url) => /^https:\/\//i.test(url);
md.renderer.rules.image = (tokens, i) => {
  const token = tokens[i];
  const alt = md.utils.escapeHtml(token.content || 'image');
  const src = token.attrGet('src') ?? '';
  return md.validateLink(src) ? `<a href="${md.utils.escapeHtml(src)}" target="_blank" rel="noreferrer">${alt}</a>` : alt;
};
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noreferrer');
  return self.renderToken(tokens, i, options);
};

type Tokens = ReturnType<typeof md.parse>;
/** Whether the tokens hold a fence with an info string, which highlight.js may know (§4.3). */
const named = (tokens: Tokens) => tokens.some((t) => t.type === 'fence' && t.info.trim() !== '');
// With highlight.js, a fence's code is colored when it knows the first word of the info string, as the editor's is by
// a file's extension (§4.10). markdown-it escapes the code itself when highlight.js doesn't know the name ('').
const colored = (hljs?: HLJSApi) => (hljs ? { ...md.options, highlight: (code: string, name: string) => colorize(hljs, name, code) ?? '' } : md.options);

/** Loads highlight.js into `set` while `code` is true, so text with no fence that names its code loads none. */
function useHighlighter(code: boolean, set: (hljs: HLJSApi | undefined) => void) {
  useEffect(() => {
    if (!code) return;
    let live = true;
    void highlighter().then((h) => live && set(h));
    return () => void (live = false);
  }, [code]);
}

/**
 * Agent-written text (an activity's statement, Codemm's replies), its code colored once highlight.js arrives, as a
 * lesson's is. It renders again only when the text changes or highlight.js arrives, not on each keystroke in the
 * editor or the rail.
 */
export function Markdown({ text, className = 'md' }: { text: string; className?: string }) {
  const [hljs, setHljs] = useState(loadedHighlighter);
  const { html, code } = useMemo(() => {
    const env = {};
    const tokens = md.parse(text, env);
    return { html: md.renderer.render(tokens, colored(hljs), env), code: named(tokens) };
  }, [text, hljs]);
  useHighlighter(code, setHljs);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** `code`: the part holds a fence with an info string, which highlight.js may know (§4.3). */
export type LessonPart = { html: string; code: boolean } | { example: number } | { diagram: string };

/**
 * A lesson rendered in one pass, cut at each example block: an unindented top-level fence (``` or ~~~) whose info
 * string is `example`, then one line holding N, then the closing fence, exactly as core finds them (core DESIGN §5),
 * and at each diagram: a top-level fence whose info string is `mermaid`, which the lesson screen draws (§4.3). Either
 * kind inside a list, a quote or another fence stays a code block.
 * Links and other references keep their definitions from anywhere in the lesson. With `dropTitle`, a leading
 * top-level heading is left out (the page shows the title above the lesson). With `hljs`, the code is colored as
 * `Markdown`'s is.
 */
export function lessonParts(text: string, dropTitle = false, hljs?: HLJSApi): LessonPart[] {
  const env = {};
  let tokens = md.parse(text, env);
  if (dropTitle && tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1') tokens = tokens.slice(tokens.findIndex((t) => t.type === 'heading_close') + 1);
  const lines = text.split(/\r\n?|\n/);
  const options = colored(hljs);
  const parts: LessonPart[] = [];
  let chunk: typeof tokens = [];
  const flush = () => {
    if (chunk.length) parts.push({ html: md.renderer.render(chunk, options, env), code: named(chunk) });
    chunk = [];
  };
  for (const token of tokens) {
    // The same test as core's exampleRefs (src/schemas.ts): three lines (open, N, close), unindented.
    const block = token.map !== null && token.map[1] - token.map[0] === 3 && /^[`~]/.test(lines[token.map[0]] ?? '');
    if (token.type === 'fence' && token.level === 0 && block && token.info.trim() === 'example' && /^[ \t]*\d+[ \t]*\n$/.test(token.content)) {
      flush();
      parts.push({ example: Number(token.content.trim()) });
    } else if (token.type === 'fence' && token.level === 0 && token.info.trim() === 'mermaid') {
      flush();
      parts.push({ diagram: token.content.replace(/\n$/, '') });
    } else {
      chunk.push(token);
    }
  }
  flush();
  return parts;
}

/** A lesson's parts, its code colored once highlight.js arrives; a lesson with no fence that names its code loads none. */
export function useLessonParts(text: string, dropTitle = false): LessonPart[] {
  const [hljs, setHljs] = useState(loadedHighlighter);
  const parts = useMemo(() => lessonParts(text, dropTitle, hljs), [text, dropTitle, hljs]);
  useHighlighter(parts.some((p) => 'code' in p && p.code), setHljs);
  return parts;
}
