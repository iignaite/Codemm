// Download buttons: the newest published GitHub release, the installer for this
// computer first. Before a release is published, "Coming soon".
import { detectPlatform, pickRelease, downloads } from './release.js';

const REPO = 'https://github.com/iignaite/Codemm';
const API = 'https://api.github.com/repos/iignaite/Codemm/releases?per_page=30';
const CACHE = 'codemm-releases';
const FRESH_MS = 10 * 60 * 1000;

const readCache = () => {
  try { return JSON.parse(sessionStorage.getItem(CACHE)); } catch { return null; }
};

/** The release list, or null if GitHub can't be reached and nothing is cached. */
async function loadReleases() {
  const cached = readCache();
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.releases;
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(8000), referrerPolicy: 'no-referrer', credentials: 'omit' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const releases = await res.json();
    try { sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), releases })); } catch {}
    return releases;
  } catch {
    return cached?.releases ?? null;
  }
}

async function platform() {
  const ua = navigator.userAgentData;
  let architecture = '';
  try { architecture = (await ua?.getHighEntropyValues(['architecture']))?.architecture ?? ''; } catch {}
  return detectPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, uaPlatform: ua?.platform, architecture });
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
// Only ever link to GitHub.
const safe = (url) => (typeof url === 'string' && url.startsWith('https://github.com/') ? url : `${REPO}/releases`);

function content(d) {
  if (d.status === 'soon') {
    return [el('div', { className: 'soon' },
      el('span', { className: 'soon-pill' }, 'Coming soon to Mac and Windows'),
      el('a', { href: REPO }, 'Source on GitHub'))];
  }
  const parts = [];
  if (d.primaries.length) {
    parts.push(el('div', { className: 'primaries' }, ...d.primaries.map((i) =>
      el('a', { className: 'btn primary big', href: safe(i.url) },
        el('span', { className: 'btn-label' }, i.label),
        el('span', { className: 'btn-detail' }, i.detail)))));
    // Both Mac builds: the browser didn't say which chip this Mac has.
    if (d.primaries.length > 1) parts.push(el('p', { className: 'chip-hint' }, 'About This Mac shows Chip on Apple Silicon and Processor on Intel.'));
  } else {
    parts.push(el('p', { className: 'desktop-only' }, 'Codemm is a desktop app for a Mac or a Windows PC.'));
  }
  // One quiet line under the buttons: the beta label and the other installers.
  const line = el('p', { className: 'others' });
  if (d.beta) line.append(el('span', { className: 'pill' }, 'Beta'));
  if (d.others.length) {
    line.append(el('span', {}, d.primaries.length ? 'Also for' : 'Download for'));
    for (const o of d.others) line.append(el('a', { href: safe(o.url) }, o.name));
  }
  if (line.childNodes.length) parts.push(line);
  return parts;
}

const [releases, p] = await Promise.all([loadReleases(), platform()]);
// GitHub unreachable: keep the static link to the Releases page.
if (releases) {
  const d = downloads(pickRelease(releases), p);
  for (const box of document.querySelectorAll('[data-download]')) box.replaceChildren(...content(d));
  for (const note of document.querySelectorAll('[data-beta]')) note.hidden = !d.beta;
}
