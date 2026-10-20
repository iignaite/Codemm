// highlight.js loads once per test file, so the replies with nothing to color go first (§2.1).
const loaded = vi.hoisted(() => vi.fn());
vi.mock('highlight.js/lib/common', async (importActual) => (loaded(), importActual()));

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarkdownIt from 'markdown-it';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { NoteEditor } from '../features/lessons/NoteEditor';
import { Rail } from './Rail';

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        {open && (
          <Dialog title="Let Codemm edit this activity?" onClose={() => setOpen(false)}>
            <Button onClick={() => setOpen(false)}>Keep trying</Button>
            <Button>Let Codemm edit</Button>
          </Dialog>
        )}
      </>
    );
  }

  it('is a modal dialog that traps focus, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Let Codemm edit this activity?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(opener.closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep trying' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Let Codemm edit' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Keep trying' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Let Codemm edit' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('Rail', () => {
  it('logs the conversation and sends questions to Codemm', async () => {
    const onAsk = vi.fn();
    render(
      <Rail
        messages={[
          { from: 'you', text: 'Just fix it for me.' },
          { from: 'codemm', text: 'In practice mode, you write the code.' },
          { from: 'codemm', text: 'Look at `setCount`.' },
        ]}
        onAsk={onAsk}
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('You: Just fix it for me.');
    expect(log).toHaveTextContent('In practice mode, you write the code.');
    expect(log.querySelector('code')).toHaveTextContent('setCount');
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why?{Enter}');
    expect(onAsk).toHaveBeenCalledWith('Why?');
    expect(screen.getByRole('textbox', { name: 'Ask Codemm' })).toHaveValue('');
  });

  it('scrolls its own log to the newest message, never the page', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const messages = [{ from: 'you' as const, text: 'Why?' }];
      const { rerender } = render(<Rail messages={messages} onAsk={vi.fn()} />);
      expect(screen.getByRole('log').scrollTop).toBe(900);
      height.mockReturnValue(1500);
      rerender(<Rail messages={[...messages, { from: 'codemm', text: 'Look at line 3.' }]} onAsk={vi.fn()} />);
      expect(screen.getByRole('log').scrollTop).toBe(1500);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      height.mockRestore();
      // @ts-expect-error jsdom has none; the test gave it one.
      delete HTMLElement.prototype.scrollIntoView;
    }
  });

  it('keeps a question within its limit, and says so', async () => {
    const user = userEvent.setup();
    render(<Rail messages={[]} onAsk={vi.fn()} />);
    const ask = screen.getByRole('textbox', { name: 'Ask Codemm' });
    await user.click(ask);
    await user.paste('q'.repeat(2500));
    expect(ask).toHaveValue('q'.repeat(2000));
    expect(screen.getByText('Up to 2,000 characters.')).toBeInTheDocument();
  });

  it('loads no highlighter for replies without a fence that names its code', async () => {
    render(<Rail messages={[{ from: 'codemm', text: 'Look at `setCount`.\n\n```\nplain\n```\n\n    indented\n' }]} onAsk={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('log').querySelector('pre code')).toHaveTextContent('plain');
    expect(loaded).not.toHaveBeenCalled();
  });

  it("colors the code in Codemm's replies once highlight.js arrives, and leaves an unknown info string plain", async () => {
    render(<Rail messages={[{ from: 'codemm', text: '```js\nlet count = 0;\n```\n\n```zzz\nlet other = 1;\n```' }]} onAsk={vi.fn()} />);
    const log = screen.getByRole('log');
    await waitFor(() => expect(log.querySelector('code.language-js .hljs-keyword')).toHaveTextContent('let'));
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(log.querySelector('code.language-js')).toHaveTextContent('let count = 0;');
    expect(log.querySelector('code.language-zzz')!.innerHTML).toBe('let other = 1;\n');
  });

  it('renders a colored reply once, not again on each keystroke while the learner asks', async () => {
    const user = userEvent.setup();
    render(<Rail messages={[{ from: 'codemm', text: 'Look at `setCount`.\n\n```js\nlet count = 0;\n```' }]} onAsk={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('log').querySelector('.hljs-keyword')).toBeTruthy());
    const parse = vi.spyOn(MarkdownIt.prototype, 'parse');
    try {
      await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why?');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe('NoteEditor', () => {
  it('keeps a note within its limit, and says so', async () => {
    const user = userEvent.setup();
    render(<NoteEditor note={'n'.repeat(19_990)} onSave={vi.fn()} onCancel={vi.fn()} />);
    const note = screen.getByRole('textbox', { name: 'My note' });
    expect(screen.queryByText('Up to 20,000 characters.')).not.toBeInTheDocument();
    await user.click(note);
    await user.paste('m'.repeat(50));
    expect((note as HTMLTextAreaElement).value).toHaveLength(20_000);
    expect(screen.getByText('Up to 20,000 characters.')).toBeInTheDocument();
  });
});
