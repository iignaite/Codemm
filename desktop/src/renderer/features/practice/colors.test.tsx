import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarkdownIt from 'markdown-it';
import { describe, expect, it, vi } from 'vitest';
import { mockWithCourse, renderApp } from '../../test-utils';
import { colorize, MAX_COLORED, nameOf } from '../../ui/colors';

const loaded = vi.fn();
vi.mock('highlight.js/lib/common', async (importActual) => (loaded(), importActual()));
vi.mock('@xterm/xterm', () => import('../../testing/xterm'));
vi.mock('@xterm/addon-fit', () => import('../../testing/xterm'));

const editor = (name: string) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
/** The colored copy under the textarea. */
const copy = () => document.querySelector('pre.hl');

/** The practice screen, its first file renamed to `rename` and its statement saying `statement`. */
async function practice({ rename, statement }: { rename?: string; statement?: string } = {}) {
  const { api, course } = await mockWithCourse({ read: true });
  const real = api.activity.bind(api);
  api.activity = async (concept) => {
    const a = await real(concept);
    return { ...a, statement: statement ?? a.statement, files: a.files.map((f, i) => (i === 0 && rename ? { ...f, path: rename } : f)) };
  };
  renderApp({ to: 'practice', concept: course.topics[0].id }, api);
  await screen.findByRole('heading', { name: 'Click Counter' });
  return userEvent.setup();
}

// The order matters: the library loads once per file, so the screen without an editor or code to color goes first.
describe("the editor's colors (§4.10)", () => {
  it('loads no highlighter on a screen without an editor or code to color', async () => {
    const { api, course } = await mockWithCourse();
    renderApp({ to: 'lesson', lessonId: course.topics[0].lessons[0].id }, api);
    await screen.findByRole('button', { name: 'Next' });
    expect(loaded).not.toHaveBeenCalled();
  });

  it("colors the code by its file's extension, under the textarea, which stays the editor", async () => {
    const user = await practice();
    await waitFor(() => expect(copy()?.querySelector('[class^="hljs-"]')).toBeTruthy());
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(copy()).toHaveAttribute('aria-hidden', 'true');
    expect(editor('Counter.jsx')).toHaveClass('lit');
    expect(copy()!.textContent).toBe(editor('Counter.jsx').value);
    await user.type(editor('Counter.jsx'), 'const later = 1;');
    expect(copy()!.textContent).toBe(editor('Counter.jsx').value);
    expect(copy()!.innerHTML).not.toMatch(/<(?!\/?span[ >])/);
  });

  it("leaves a file plain when highlight.js knows nothing by its extension, and colors the next file it knows", async () => {
    const user = await practice({ rename: 'Counter.zzz' });
    await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
    await waitFor(() => expect(copy()).toBeTruthy());
    await user.click(screen.getByRole('tab', { name: 'Counter.zzz' }));
    expect(copy()).toBeNull();
    expect(editor('Counter.zzz')).not.toHaveClass('lit');
  });

  it('lines the copy up with a textarea that was already scrolled when the copy appears', async () => {
    const user = await practice({ rename: 'Counter.zzz' });
    Object.defineProperty(editor('Counter.zzz'), 'scrollLeft', { value: 120, configurable: true });
    const scrolled = vi.fn();
    Object.defineProperty(HTMLPreElement.prototype, 'scrollLeft', { get: () => 0, set: scrolled, configurable: true });
    try {
      await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
      await waitFor(() => expect(copy()).toBeTruthy());
      expect(scrolled).toHaveBeenCalledWith(120);
    } finally {
      Reflect.deleteProperty(HTMLPreElement.prototype, 'scrollLeft');
    }
  });

  it('escapes markup in the code', async () => {
    const { default: hljs } = await import('highlight.js/lib/common');
    const code = '</pre><img src=x onerror=alert(1)>';
    const shown = document.createElement('div');
    shown.innerHTML = colorize(hljs, 'html', code)!;
    expect(shown.querySelector(':not(span)')).toBeNull();
    expect(shown.textContent).toBe(code);
  });

  it('asks about the extension, or the name of a file without one, and leaves a long file plain', async () => {
    expect(nameOf('src/main.PY')).toBe('py');
    expect(nameOf('Makefile')).toBe('makefile');
    expect(nameOf('.env')).toBe('.env');
    const { default: hljs } = await import('highlight.js/lib/common');
    expect(colorize(hljs, 'js', 'let x = 1;')).toContain('hljs-keyword');
    expect(colorize(hljs, 'js', 'x'.repeat(MAX_COLORED + 1))).toBeUndefined();
    expect(colorize(hljs, 'zzz', 'let x = 1;')).toBeUndefined();
  });
});

describe("the statement's colors (§2.1)", () => {
  it("colors the statement's code by its fence's info string, and doesn't render it again on each keystroke", async () => {
    const user = await practice({ statement: 'Count the clicks.\n\n```js\nlet count = 0;\n```\n\n```zzz\nlet other = 1;\n```' });
    const statement = screen.getByRole('region', { name: 'Click Counter' });
    await waitFor(() => expect(statement.querySelector('code.language-js .hljs-keyword')).toHaveTextContent('let'));
    expect(statement.querySelector('code.language-zzz')!.innerHTML).toBe('let other = 1;\n');
    const parse = vi.spyOn(MarkdownIt.prototype, 'parse');
    try {
      await user.type(editor('Counter.jsx'), 'x');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
