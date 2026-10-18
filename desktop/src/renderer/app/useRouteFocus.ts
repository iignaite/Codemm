import { useEffect, useRef, type RefObject } from 'react';
import type { Route } from './router';

/** How long a screen may take to show its heading (it loads first). */
const WAIT_MS = 10_000;

/**
 * Moves focus to the new screen's h1 after a route change, so a screen reader starts there (§1, WCAG AA). Never on
 * the first screen, and never over focus the learner or the screen gave since (the goal's text box, say). A screen
 * that is still loading gets its heading focused once it appears, unless focus moved meanwhile: any move (a Tab, a
 * click, a dialog focusing its button) means someone else chose, even if focus later falls back to the page.
 */
export function useRouteFocus(route: Route, container: RefObject<HTMLElement | null>) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const root = container.current;
    if (!root) return;
    const before = document.activeElement;
    // A field has focus because a screen gave it (autoFocus) or the learner chose it: it keeps it.
    const field = (el: Element) => el.matches('input, textarea, select, [contenteditable="true"]');
    const free = () => {
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected) return true;
      return now === before && !field(now);
    };
    const tryFocus = () => {
      const heading = root.querySelector('h1');
      if (!heading) return false;
      if (free()) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      return true;
    };
    if (tryFocus()) return;
    const watch = new MutationObserver(() => {
      if (tryFocus()) stop();
    });
    const timer = setTimeout(() => stop(), WAIT_MS);
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      document.removeEventListener('focusin', stop);
    };
    watch.observe(root, { childList: true, subtree: true });
    document.addEventListener('focusin', stop);
    return stop;
  }, [route, container]);
}
