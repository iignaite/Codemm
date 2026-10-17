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
