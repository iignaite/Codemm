import MarkdownIt from 'markdown-it';

// Agent-written text (lessons, statements): raw HTML stripped, links only to
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

export function Markdown({ text, className = 'md' }: { text: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: md.render(text) }} />;
}

export type LessonPart = { html: string } | { example: number };

/**
 * A lesson rendered in one pass, cut at each example block: an unindented top-level fence (``` or ~~~) whose info
 * string is `example`, then one line holding N, then the closing fence, exactly as core finds them (core DESIGN §5).
 * Links and other references keep their definitions from anywhere in the lesson. With `dropTitle`, a leading
 * top-level heading is left out (the page shows the title above the lesson).
 */
export function lessonParts(text: string, dropTitle = false): LessonPart[] {
  const env = {};
  let tokens = md.parse(text, env);
  if (dropTitle && tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1') tokens = tokens.slice(tokens.findIndex((t) => t.type === 'heading_close') + 1);
  const lines = text.split(/\r\n?|\n/);
  const parts: LessonPart[] = [];
  let chunk: typeof tokens = [];
  const flush = () => {
    if (chunk.length) parts.push({ html: md.renderer.render(chunk, md.options, env) });
    chunk = [];
  };
  for (const token of tokens) {
    // The same test as core's exampleRefs (src/schemas.ts): three lines (open, N, close), unindented.
    const block = token.map !== null && token.map[1] - token.map[0] === 3 && /^[`~]/.test(lines[token.map[0]] ?? '');
    if (token.type === 'fence' && token.level === 0 && block && token.info.trim() === 'example' && /^[ \t]*\d+[ \t]*\n$/.test(token.content)) {
      flush();
      parts.push({ example: Number(token.content.trim()) });
    } else {
      chunk.push(token);
    }
  }
  flush();
  return parts;
}
