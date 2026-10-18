// Links open in the learner's browser only after a click, and only for https
// URLs (DESIGN §2.1).
export function isSafeLink(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The window-open handler for every web contents: an https link opens in the learner's browser (`open` is
 * shell.openExternal), and nothing ever opens a window inside the app.
 */
export const openOutside = (open: (url: string) => unknown) => ({ url }: { url: string }): { action: 'deny' } => {
  if (isSafeLink(url)) void open(url);
  return { action: 'deny' };
};
