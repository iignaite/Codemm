// jsdom can't lay out xterm.js, so this stand-in records what it was given; the real one runs in e2e.
// Tests use it with vi.mock('@xterm/xterm', () => import('<this file>')) and the same for '@xterm/addon-fit'.

/** What the pane gave the terminal, and how to type into it or press a key. */
export const xterm = {
  written: '',
  type: (_data: string): void => undefined,
  keys: (_e: { key: string }): boolean => true,
  options: {} as Record<string, unknown>,
  resets: 0,
};

export class Terminal {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown> = {}) {
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
}

export class FitAddon {
  fit() {}
}
