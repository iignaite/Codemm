// The app's own origin (DESIGN §2.1): app://codemm serves only the built
// renderer, under the spec's CSP, and IPC answers only an app window's top
// frame on that origin.
import { join, normalize, sep } from 'node:path';

export const ORIGIN = 'app://codemm';
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** The file under `root` that an app://codemm URL names, or null for anything else. */
export function fileFor(url: string, root: string): string | null {
  let parsed: URL;
  let path: string;
  try {
    parsed = new URL(url);
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'app:' || parsed.host !== 'codemm' || path.includes('\0')) return null;
  const base = normalize(root);
  const file = normalize(join(base, path === '/' ? 'index.html' : path));
  return file.startsWith(base + sep) ? file : null;
}

/** True only for an app window's own top frame, still on the app's origin. */
export function fromAppWindow<C extends { mainFrame: unknown }>(event: { sender: C; senderFrame: { url: string } | null }, windows: Set<C>): boolean {
  const frame = event.senderFrame;
  return Boolean(frame && windows.has(event.sender) && frame === event.sender.mainFrame && frame.url.startsWith(`${ORIGIN}/`));
}
