import { useEffect } from 'react';

function focusHeading(): boolean {
  if (document.activeElement && document.activeElement !== document.body) return true;
  const h1 = document.querySelector<HTMLElement>('h1');
  if (!h1) return false;
  h1.tabIndex = -1;
  h1.focus({ preventScroll: true });
  return true;
}

/**
 * After each navigation, start keyboard and screen reader users at the new
 * screen's heading, unless the screen already focused something itself.
 * Screens that load data render their heading later, so wait for it.
 */
export function useFocusOnNavigate(key: unknown) {
  useEffect(() => {
    if (focusHeading()) return;
    const watch = new MutationObserver(() => focusHeading() && watch.disconnect());
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [key]);
}
