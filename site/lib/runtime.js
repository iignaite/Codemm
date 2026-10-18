// Wires the app to the real environment, once per function instance.
import { createApp } from './app.js';
import { openDb } from './db.js';

const RELEASES = 'https://api.github.com/repos/iignaite/Codemm/releases?per_page=30';
const CACHE_MS = 5 * 60 * 1000;
let cached = null;

/** GitHub's release list, cached per instance; a stale copy if GitHub fails. */
async function releases() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  try {
    const res = await fetch(RELEASES, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'codemm-site' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('Unexpected GitHub answer');
    cached = { at: Date.now(), list };
    return list;
  } catch (e) {
    if (cached) return cached.list;
    throw e;
  }
}

let app;
export function getApp() {
  app ??= createApp({ db: openDb(process.env), secret: process.env.SITE_SECRET, now: Date.now, releases });
  return app;
}
