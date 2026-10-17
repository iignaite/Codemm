import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

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
