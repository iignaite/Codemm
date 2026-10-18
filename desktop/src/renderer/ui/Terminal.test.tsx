import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom can't lay out xterm.js, so a stand-in records what it was given; the real one runs in e2e.
const xterm = vi.hoisted(() => ({ written: '' as string, type: (_data: string) => undefined as void, keys: (_e: { key: string }): boolean => true, options: {} as Record<string, unknown>, resets: 0 }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      xterm.options = options;
    }
    loadAddon() {}
    open() {}
    write(text: string) {
      xterm.written += text;
    }
    reset() {
      xterm.resets++;
    }
    onData(listener: (data: string) => void) {
      xterm.type = listener;
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
    attachCustomKeyEventHandler(handler: (e: { key: string }) => boolean) {
      xterm.keys = handler;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

import { Terminal, type TerminalHandle } from './Terminal';

beforeEach(() => {
  xterm.written = '';
  xterm.resets = 0;
});

const mirror = () => screen.getByRole('log', { name: 'Terminal for main.py, as text' });
const type = (data: string) => act(() => xterm.type(data));

describe('Terminal', () => {
  it('is a labelled region headed Terminal, with its status, and a text mirror for screen readers', () => {
    const ref = createRef<TerminalHandle>();
    render(<Terminal ref={ref} label="Terminal for main.py" status="1:52 left" />);
    const region = screen.getByRole('region', { name: 'Terminal for main.py' });
    expect(region).toHaveTextContent('Terminal');
    expect(region).toHaveTextContent('1:52 left');
    act(() => {
      ref.current!.command('python3 main.py');
      ref.current!.write("\x1b[32mWhat's\x1b[0m your name? ");
      ref.current!.write('oops\n', 'stderr');
      ref.current!.line('Time is up.', 'fail');
    });
    // The pane keeps colors; the mirror keeps the plain text, each Codemm line on its own line.
    expect(xterm.written).toContain('\x1b[32m');
    expect(mirror().textContent).toBe("$ python3 main.py\nWhat's your name? oops\nTime is up.\n");
  });

  it('sends each typed line with its newline, echoing it and honoring Backspace', () => {
    const onInput = vi.fn();
    render(<Terminal label="Terminal for main.py" onInput={onInput} />);
    type('Adx');
    type('\x7f');
    type('a\r');
    expect(onInput).toHaveBeenCalledWith('Ada\n');
    expect(xterm.written).toBe('Adx\b \ba\r\n');
    expect(mirror().textContent).toBe('Ada\n');
    // A pasted block sends one line per newline; arrow keys and other escapes are ignored.
    type('\x1b[A');
    type('one\rtwo\r');
    expect(onInput.mock.calls.map((c) => c[0])).toEqual(['Ada\n', 'one\n', 'two\n']);
  });

  it('never traps the keyboard: Tab is left to move focus', () => {
    render(<Terminal label="Terminal for main.py" onInput={vi.fn()} />);
    expect(xterm.keys({ key: 'Tab' })).toBe(false);
    expect(xterm.keys({ key: 'a' })).toBe(true);
  });

  it('is read-only without onInput', () => {
    render(<Terminal label="Terminal for main.py" />);
    expect(xterm.options.disableStdin).toBe(true);
    type('hi\r');
    expect(xterm.written).toBe('');
  });

  it('clears the pane and the mirror', () => {
    const ref = createRef<TerminalHandle>();
    render(<Terminal ref={ref} label="Terminal for main.py" />);
    act(() => ref.current!.write('old\n'));
    act(() => ref.current!.clear());
    expect(xterm.resets).toBe(1);
    expect(mirror().textContent).toBe('');
  });

  it('keeps only the end of a long run in the mirror', () => {
    const ref = createRef<TerminalHandle>();
    render(<Terminal ref={ref} label="Terminal for main.py" />);
    act(() => ref.current!.write(`${'x'.repeat(30_000)}end\n`));
    expect(mirror().textContent!.length).toBeLessThanOrEqual(20_000);
    expect(mirror().textContent!.endsWith('end\n')).toBe(true);
  });
});
