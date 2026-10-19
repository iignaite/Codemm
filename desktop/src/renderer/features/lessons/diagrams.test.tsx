// The real mermaid draws in these tests; jsdom has no layout, so text measures a fixed size. This file comes first
// in its own module graph: the first test needs mermaid to be unloaded (§4.3, diagrams).
const loaded = vi.hoisted(() => vi.fn());
vi.mock('mermaid', async (importActual) => (loaded(), importActual()));

import { configure, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { mockWithCourse, renderApp } from '../../test-utils';

beforeAll(() => {
  // The first drawing loads mermaid and the code for its kind of diagram, which takes seconds under a test run.
  configure({ asyncUtilTimeout: 30_000 });
  Object.assign(SVGElement.prototype, { getBBox: () => ({ x: 0, y: 0, width: 60, height: 20 }), getComputedTextLength: () => 60 });
});

/** The first lesson of a course, saying `markdown`. */
async function lessonSaying(markdown: string): Promise<{ api: CodemmApi; id: string }> {
  const { api, course } = await mockWithCourse({ read: true });
  const id = course.topics[0].lessons[0].id;
  const real = await api.lesson(id);
  api.lesson = async () => ({ ...real, markdown });
  return { api, id };
}

const FLOW = 'flowchart TD\n  accTitle: Reading input\n  accDescr: Start leads to a check. Yes ends, no goes back to start.\n  A[Start] --> B{Valid?}\n  B -->|yes| C[Done]\n  B -->|no| A';

/** The image a diagram became, read back as XML (an image that isn't well-formed XML shows nothing). */
function drawn(img: HTMLElement): XMLDocument {
  const src = img.getAttribute('src')!;
  expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const doc = new DOMParser().parseFromString(decodeURIComponent(src.slice(src.indexOf(',') + 1)), 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('a lesson without a diagram', () => {
  it('loads nothing for diagrams', async () => {
    const { api, id } = await lessonSaying('# Title\n\nJust words.\n\n```\nplain code\n```');
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    expect(await screen.findByText('Just words.')).toBeInTheDocument();
    expect(container.querySelector('.diagram')).toBeNull();
    expect(loaded).not.toHaveBeenCalled();
  });
});

describe('diagrams in a lesson', { timeout: 60_000 }, () => {
  // The test above needs mermaid unloaded; from here it loads.
  beforeAll(async () => {
    await import('./drawDiagram');
  }, 30_000);

  it('draw a flowchart as an image with its text alternative, in the lesson where it was placed', async () => {
    const { api, id } = await lessonSaying(`# Title\n\nBefore\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nAfter`);
    renderApp({ to: 'lesson', lessonId: id }, api);
    const img = await screen.findByRole('img', { name: 'Reading input. Start leads to a check. Yes ends, no goes back to start.' });
    expect(loaded).toHaveBeenCalledTimes(1);
    const svg = drawn(img);
    expect([...svg.querySelectorAll('text')].map((t) => t.textContent?.trim())).toEqual(expect.arrayContaining(['Start', 'Valid?', 'Done', 'yes', 'no']));
    // It keeps its natural size, in the app's fonts, which an image can't borrow from the page.
    const root = svg.documentElement;
    expect(Number(root.getAttribute('width'))).toBeGreaterThan(0);
    expect(root.getAttribute('height')).toBeTruthy();
    const css = [...svg.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(css).toContain('data:font/woff2;base64,');
    // The font travels in the image, and mermaid's own rules use it.
    expect(css.match(/font-family:\s*"?Atkinson Hyperlegible Next/g)!.length).toBeGreaterThan(1);
    // The code block for the fence is gone, and the text around it stays.
    expect(screen.queryByText('flowchart TD', { exact: false })).toBeNull();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('draw charts and the other kinds the brief names', async () => {
    const kinds: Record<string, string> = {
      'a pie': 'pie title Pets\n  accTitle: Pets\n  "Dogs" : 386\n  "Cats" : 85',
      'an xychart': 'xychart\n  title "Steps"\n  accTitle: Steps\n  x-axis [1, 2, 3, 4]\n  y-axis "Steps" 0 --> 20\n  line [1, 4, 9, 16]',
      'a sequence diagram': 'sequenceDiagram\n  accTitle: Sequence\n  A->>B: ask\n  B-->>A: answer',
      'a state diagram': 'stateDiagram-v2\n  accTitle: States\n  [*] --> Idle\n  Idle --> Busy: go\n  Busy --> [*]',
      'a class diagram': 'classDiagram\n  accTitle: Classes\n  class Stack {\n    +push(x)\n    +pop()\n  }',
    };
    const { api, id } = await lessonSaying(`# T\n\n${Object.values(kinds).map((k) => `\`\`\`mermaid\n${k}\n\`\`\``).join('\n\n')}`);
    renderApp({ to: 'lesson', lessonId: id }, api);
    for (const name of ['Pets', 'Steps', 'Sequence', 'States', 'Classes']) {
      const svg = drawn(await screen.findByRole('img', { name: new RegExp(`^${name}`) }));
      expect(svg.querySelector('svg')).not.toBeNull();
    }
    expect(screen.queryByText(/This diagram didn't draw/)).toBeNull();
  });

  it('have a text alternative even when the agent wrote none', async () => {
    const { api, id } = await lessonSaying('# T\n\n```mermaid\nflowchart LR\n  A --> B\n```');
    renderApp({ to: 'lesson', lessonId: id }, api);
    expect(await screen.findByRole('img', { name: /^Diagram\b.*A --> B/ })).toBeInTheDocument();
  });

  it('show their source with a short note when they do not draw, and the lesson goes on', async () => {
    const { api, id } = await lessonSaying('# T\n\nBefore\n\n```mermaid\nflowchart TD\n  A --> --> B(\n```\n\nAfter');
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    expect(await screen.findByText("This diagram didn't draw. Here is its source.")).toBeInTheDocument();
    expect(screen.getByText('A --> --> B(', { exact: false, selector: 'code' })).toBeInTheDocument();
    expect(container.querySelector('.diagram img')).toBeNull();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    // Mermaid's own error drawing is left out, and so is anything it leaves in the page.
    expect(document.querySelector('[id^="ddiagram-"], .error-icon')).toBeNull();
  });

  it('draw agent-written labels as inert text: no markup, script, handler or remote reference survives', async () => {
    const evil = [
      'flowchart TD',
      '  A["<img src=x onerror=alert(1)><script>alert(2)</script>"] --> B["<a href=\'javascript:alert(3)\'>go</a>"]',
      '  B --> C["<iframe src=\'https://example.com\'></iframe>"]',
      '  click A call alert()',
      '  click B "https://example.com" _blank',
      '  %%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%',
    ].join('\n');
    const { api, id } = await lessonSaying(`# T\n\n\`\`\`mermaid\n${evil}\n\`\`\``);
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    const img = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('figure.diagram img');
      expect(found).not.toBeNull();
      return found!;
    });
    // In the page: an image, and nothing the labels could have added around it.
    const reader = container.querySelector('main.reader')!;
    for (const tag of ['script', 'iframe', 'a[href^="javascript"]', 'foreignObject']) expect(reader.querySelector(tag)).toBeNull();
    expect(img.closest('figure')!.querySelector('svg')).toBeNull();
    expect(reader.querySelector('img[onerror], img[src="x"]')).toBeNull();
    // In the image: text, with no element, handler or reference that could do anything.
    const svg = drawn(img);
    expect(svg.querySelector('script, iframe, foreignObject, image, a')).toBeNull();
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on/i);
        if (!attr.name.startsWith('xmlns')) expect(attr.value).not.toMatch(/javascript:|https?:\/\//i);
      }
    }
    expect(svg.querySelectorAll('text').length).toBeGreaterThan(0);
  });

  it('keep the settings of the app, whatever the source says', async () => {
    const loud = '%%{init: {"htmlLabels": true, "theme": "dark", "layout": "elk", "look": "neo", "themeVariables": {"primaryColor": "#ff0000"}}}%%\nflowchart TD\n  A[Start] --> B[End]';
    const { api, id } = await lessonSaying(`# T\n\n\`\`\`mermaid\n${loud}\n\`\`\``);
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    const img = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('figure.diagram img');
      expect(found).not.toBeNull();
      return found!;
    });
    const svg = drawn(img);
    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svg.documentElement.outerHTML).not.toMatch(/#ff0000/i);
    const { default: mermaid } = await import('mermaid');
    // What directives in the source can't touch: mermaid's own list, and the settings of this app on top of it.
    expect(mermaid.mermaidAPI.getSiteConfig().secure).toEqual(expect.arrayContaining(['securityLevel', 'maxTextSize', 'maxEdges', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'look', 'layout', 'fontFamily']));
    expect(mermaid.mermaidAPI.getConfig()).toMatchObject({ securityLevel: 'strict', htmlLabels: false, layout: 'dagre', look: 'classic', theme: 'base', maxTextSize: 20_000 });
  });

  it('show the source of a diagram too large to draw, not a box that says so', async () => {
    const big = `flowchart TD\n${Array.from({ length: 1500 }, (_, i) => `  N${i} --> N${i + 1}`).join('\n')}`;
    expect(big.length).toBeGreaterThan(20_000);
    const { api, id } = await lessonSaying(`# T\n\n\`\`\`mermaid\n${big}\n\`\`\``);
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    expect(await screen.findByText("This diagram didn't draw. Here is its source.")).toBeInTheDocument();
    expect(container.querySelector('.diagram img')).toBeNull();
  });

  it('draw once, and reopen at once', async () => {
    const { api, id } = await lessonSaying(`# T\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``);
    const first = renderApp({ to: 'lesson', lessonId: id }, api);
    const img = await screen.findByRole('img', { name: /^Reading input/ });
    const src = img.getAttribute('src');
    first.unmount();
    renderApp({ to: 'lesson', lessonId: id }, api);
    // The lesson itself reads from the cache; the diagram needs no wait either.
    const again = await screen.findByRole('img', { name: /^Reading input/ });
    expect(again.getAttribute('src')).toBe(src);
  });

  it('use the palette of the app', async () => {
    const tokens = readFileSync(join(__dirname, '../../styles/tokens.css'), 'utf8');
    const { palette } = await import('./drawDiagram');
    for (const [name, value] of Object.entries(palette)) expect(tokens, name).toContain(`--${name}: ${value};`);
  });
});
