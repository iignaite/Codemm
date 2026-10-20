import { render, waitFor } from '@testing-library/react';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { describe, expect, it, vi } from 'vitest';
import { highlighter } from './colors';
import { lessonParts, Markdown, useLessonParts } from './Markdown';

const html = (text: string) => render(<Markdown text={text} />).container;

describe('Markdown (§2.1)', () => {
  it('renders headings, emphasis, lists and code', () => {
    const c = html('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```\nconst a = 1;\n```');
    expect(c.querySelector('h1')).toHaveTextContent('Title');
    expect(c.querySelector('strong')).toHaveTextContent('bold');
    expect(c.querySelectorAll('li')).toHaveLength(2);
    expect(c.querySelector('pre code')).toHaveTextContent('const a = 1;');
  });

  it('strips raw HTML', () => {
    const c = html('<script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">');
    expect(c.querySelector('script')).toBeNull();
    expect(c.querySelector('img')).toBeNull();
  });

  it('turns images into plain links, so nothing remote loads', () => {
    const c = html('![a diagram](https://example.com/d.png)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('a')).toHaveAttribute('href', 'https://example.com/d.png');
    expect(c.querySelector('a')).toHaveTextContent('a diagram');
  });

  it('keeps only https links, opened outside the app', () => {
    const c = html('[good](https://example.com) [bad](http://example.com) [worse](javascript:alert(1))');
    const links = c.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noreferrer');
  });
});

describe('lessonParts', () => {
  const fence = (n: number, mark = '```') => `${mark}example\n${n}\n${mark}`;

  it('cuts the lesson at top-level example fences, tildes included, keeping links defined elsewhere', () => {
    const parts = lessonParts(`See [docs][d].\n\n${fence(1)}\n\nThen\n\n${fence(2, '~~~')}\n\n[d]: https://example.com/docs\n`);
    expect(parts.map((p) => ('example' in p ? p.example : 'html'))).toEqual(['html', 1, 'html', 2]);
    expect((parts[0] as { html: string }).html).toContain('href="https://example.com/docs"');
  });

  // Core pins the same cases (test/schemas.test.ts): both use markdown-it's tokens.
  it.each([
      ["- item\n  ~~~text\n  code\n\n~~~example\n1\n~~~", [1]],
      ["~~~example\n1\n~~~\u00a0", []],
      ["~~~example\r1\r~~~", [1]],
      ["```example\n\n1\n\n```\n", []],
      ["```example\n1\n", []],
      ["   ````md\n```example\n1\n```\n   ````\n", []],
    ])('finds the same example blocks as core in %j', (text, refs) => {
    expect(lessonParts(text as string).flatMap((p) => ('example' in p ? [p.example] : []))).toEqual(refs);
  });

  it('drops a leading title without touching what follows it', () => {
    expect(lessonParts('#\n```example\n1\n```', true).flatMap((p) => ('example' in p ? [p.example] : []))).toEqual([1]);
    const [first] = lessonParts('# Title\n\nText', true);
    expect((first as { html: string }).html).not.toContain('Title');
    expect((first as { html: string }).html).toContain('Text');
  });

  it('cuts the lesson at a top-level mermaid fence, and leaves one inside a list or another fence as code', () => {
    const parts = lessonParts('Before\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nAfter\n\n- item\n\n  ```mermaid\n  flowchart TD\n  ```\n\n````md\n```mermaid\nx\n```\n````\n');
    expect(parts.map((p) => ('diagram' in p ? 'diagram' : 'html'))).toEqual(['html', 'diagram', 'html']);
    expect(parts[1]).toEqual({ diagram: 'flowchart TD\n  A --> B' });
    expect((parts[2] as { html: string }).html).toContain('<pre><code class="language-mermaid">');
  });

  it('shows, never runs, an example fence inside another fence or indented', () => {
    const parts = lessonParts(`\`\`\`\`md\n${fence(1)}\n\`\`\`\`\n\n    \`\`\`example\n    2\n    \`\`\`\n`);
    expect(parts.every((p) => 'html' in p)).toBe(true);
  });
});

describe("a lesson's code (§4.3)", () => {
  const shown = (text: string, colors?: typeof hljs) => {
    const div = document.createElement('div');
    div.innerHTML = lessonParts(text, false, colors).map((p) => ('html' in p ? p.html : '')).join('');
    return div;
  };

  it("colors a fence by its info string's first word, as highlight.js's own table knows it, escaping the code", () => {
    const code = 'let a = "</code></pre><img src=x onerror=alert(1)>";\n';
    const c = shown(`\`\`\`js runnable\n${code}\`\`\``, hljs).querySelector('pre > code.language-js')!;
    expect(c.querySelector('.hljs-keyword')).toHaveTextContent('let');
    expect(c.querySelector(':not(span)')).toBeNull();
    expect(c.textContent).toBe(code);
  });

  it('leaves an unknown or empty info string, and indented code, as they were', () => {
    const text = '```zzz\nlet a = 1;\n```\n\n```\nlet a = 1;\n```\n\n    let a = 1;\n';
    expect(shown(text, hljs).innerHTML).toBe(shown(text).innerHTML);
    expect(shown(text, hljs).querySelector('[class^="hljs-"]')).toBeNull();
  });

  it('still cuts at example and mermaid fences, and keeps stripping raw HTML', () => {
    const parts = lessonParts(`<script>alert(1)</script>\n\n${'```example\n1\n```'}\n\n${'```mermaid\nflowchart TD\n```'}\n\n${'```js\nlet a;\n```'}`, false, hljs);
    expect(parts.map((p) => ('html' in p ? 'html' : 'example' in p ? 'example' : 'diagram'))).toEqual(['html', 'example', 'diagram', 'html']);
    expect((parts[0] as { html: string }).html).not.toContain('<script');
  });

  it('colors a lesson opened after highlight.js has loaded on its first paint', async () => {
    await highlighter();
    const painted: string[] = [];
    function Reader() {
      const [part] = useLessonParts('```js\nlet a;\n```');
      painted.push((part as { html: string }).html);
      return null;
    }
    render(<Reader />);
    expect(painted[0]).toContain('hljs-keyword');
  });

  it('marks the parts with a fence that names its code, so a lesson without one loads no highlighter', () => {
    const code = (text: string) => lessonParts(text).map((p) => 'html' in p && p.code);
    expect(code('Words.\n\n```\nplain\n```\n\n    indented\n\n```example\n1\n```\n\n```mermaid\nflowchart TD\n```')).toEqual([false, false, false]);
    expect(code('```zzz\nx\n```\n\n```example\n1\n```\n\n- item\n\n  ```js\n  let a;\n  ```\n')).toEqual([true, false, true]);
  });
});

describe("agent text's code (§2.1)", () => {
  it("colors a fence by its info string's first word once highlight.js arrives, escaping the code", async () => {
    const code = 'let a = "</code></pre><img src=x onerror=alert(1)>";\n';
    const c = html(`<script>alert(1)</script>\n\n\`\`\`js runnable\n${code}\`\`\``);
    await waitFor(() => expect(c.querySelector('pre > code.language-js .hljs-keyword')).toHaveTextContent('let'));
    expect(c.querySelector('pre > code :not(span)')).toBeNull();
    expect(c.querySelector('pre > code')!.textContent).toBe(code);
    expect(c.querySelector('script')).toBeNull();
  });

  it('leaves an unknown or empty info string, and indented code, as they were', async () => {
    await highlighter();
    const text = '```zzz\nlet a = 1;\n```\n\n```\nlet a = 1;\n```\n\n    let a = 1;\n';
    const [plain] = lessonParts(text);
    expect(html(text).innerHTML).toBe(`<div class="md">${(plain as { html: string }).html}</div>`);
  });

  it('renders its text again only when the text changes, not on each render around it', () => {
    const parse = vi.spyOn(MarkdownIt.prototype, 'parse');
    try {
      const { rerender } = render(<Markdown text="Some *text*." />);
      rerender(<Markdown text="Some *text*." />);
      rerender(<Markdown text="Some *text*." />);
      expect(parse).toHaveBeenCalledTimes(1);
      rerender(<Markdown text="Other text." />);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
  });
});
