import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/** What a screen writes to the pane. Program output keeps its ANSI colors. */
export interface TerminalHandle {
  /** Prints `$ <cmd>` on a line of its own. */
  command(cmd: string): void;
  /** Program output, as it comes. stderr shows in the error color. */
  write(text: string, stream?: 'stdout' | 'stderr'): void;
  /** One of Codemm's own lines, such as a summary, on a line of its own. */
  line(text: string, tone?: 'ok' | 'fail' | 'quiet'): void;
  clear(): void;
  /** Moves keyboard focus into the pane, for typing. */
  focus(): void;
}

export interface TerminalProps {
  /** The screen-reader name, such as "Terminal for main.py". */
  label: string;
  /** The header's right side, such as the time left. */
  status?: string;
  /** Set while a program can read input: typing is echoed and each line is sent with its "\n". Without it, read-only. */
  onInput?: (text: string) => void;
}

// Every color reaches WCAG AA (at least 5.7:1) on the pane's navy.
const THEME: ITheme = {
  background: '#0B1F44',
  foreground: '#E6ECF5',
  cursor: '#E6ECF5',
  cursorAccent: '#0B1F44',
  selectionBackground: '#2A4677',
  black: '#8A9BB8',
  red: '#FF8F8F',
  green: '#6EE59A',
  yellow: '#F5D76E',
  blue: '#8DB8FF',
  magenta: '#E3A3FF',
  cyan: '#72E4EA',
  white: '#E6ECF5',
  brightBlack: '#A3B3CC',
  brightRed: '#FFB0B0',
  brightGreen: '#9AF0B8',
  brightYellow: '#FAE7A0',
  brightBlue: '#B5D0FF',
  brightMagenta: '#EEC4FF',
  brightCyan: '#A6F0F3',
  brightWhite: '#FFFFFF',
};
const TONE = { ok: '\x1b[32m', fail: '\x1b[31m', quiet: '\x1b[90m' };
const RESET = '\x1b[0m';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** The mirror keeps the end of a run: enough to read back, never the whole flood. */
const MIRROR_MAX = 20_000;

/**
 * The terminal pane: a dark, monospace xterm.js screen headed "Terminal". A visually hidden log mirrors its plain
 * text for screen readers. Screens write to it through the handle; typed lines go to `onInput`.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ label, status, onInput }, ref) {
  const screen = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const labelAtStart = useRef(label);
  const input = useRef(onInput);
  input.current = onInput;
  /** Whether the last thing written ended a line. */
  const atLineStart = useRef(true);

  const show = (text: string, plain = text.replace(ANSI, '')) => {
    if (!text) return;
    term.current?.write(text);
    const m = mirror.current;
    if (m) m.textContent = ((m.textContent ?? '') + plain).slice(-MIRROR_MAX);
    atLineStart.current = plain ? plain.endsWith('\n') : atLineStart.current;
  };
  const ownLine = (text: string, color = '') => show(`${atLineStart.current ? '' : '\n'}${color}${text}${color && RESET}\n`);

  useImperativeHandle(ref, () => ({
    command: (cmd) => ownLine(`${TONE.quiet}$${RESET} ${cmd}`),
    write: (text, stream = 'stdout') => show(stream === 'stderr' ? `${TONE.fail}${text}${RESET}` : text, text.replace(ANSI, '')),
    line: (text, tone) => ownLine(text, tone && TONE[tone]),
    focus: () => term.current?.focus(),
    clear: () => {
      term.current?.reset();
      if (mirror.current) mirror.current.textContent = '';
      atLineStart.current = true;
    },
  }));

  useEffect(() => {
    const el = screen.current!;
    const xterm = new XTerm({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const styles = adoptStyles(el);
    xterm.open(el);
    term.current = xterm;
    // Each pane's input is named for its pane: a page can hold more than one.
    xterm.textarea?.setAttribute('aria-label', `${labelAtStart.current} input`);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet.
      }
    };
    refit();
    const resized = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refit);
    resized?.observe(el);

    // Tab and Shift+Tab move focus as anywhere else, so the pane never traps the keyboard.
    xterm.attachCustomKeyEventHandler((e) => e.key !== 'Tab');
    // A line editor: the program reads a pipe, not a terminal, so the pane echoes and sends whole lines.
    let typed = '';
    const typing = xterm.onData((data) => {
      if (!input.current || data.startsWith('\x1b')) return;
      for (const ch of data) {
        if (ch === '\r') {
          const lineText = typed;
          typed = '';
          show('\r\n', `${lineText}\n`);
          input.current(`${lineText}\n`);
        } else if (ch === '\x7f' || ch === '\b') {
          if (!typed) continue;
          typed = [...typed].slice(0, -1).join('');
          xterm.write('\b \b');
        } else if (ch >= ' ' || ch === '\t') {
          typed += ch;
          xterm.write(ch);
        }
      }
    });
    return () => {
      typing.dispose();
      resized?.disconnect();
      xterm.dispose();
      styles();
      term.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.disableStdin = !onInput;
  }, [onInput]);

  return (
    <section className="term" aria-label={label}>
      <div className="term-head">
        <span>Terminal</span>
        {status && <span className="term-status">{status}</span>}
      </div>
      <div className="term-screen" ref={screen} />
      <div className="sr-only" role="log" aria-label={`${label}, as text`} ref={mirror} />
    </section>
  );
});

/**
 * xterm.js writes its layout and theme rules into <style> elements, which the app's CSP blocks (style-src 'self').
 * Rather than loosen the CSP, the rules of style elements inside the pane are copied into constructed stylesheets,
 * which the CSP doesn't govern. Only this pane's own elements are copied; returns a function that removes them.
 */
function adoptStyles(root: HTMLElement): () => void {
  if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) return () => undefined;
  const sheets = new Map<HTMLStyleElement, CSSStyleSheet>();
  const sync = () => {
    for (const el of root.querySelectorAll('style')) {
      let sheet = sheets.get(el);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheets.set(el, sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(el.textContent ?? '');
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    const ours = new Set(sheets.values());
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => !ours.has(s));
  };
}
