import { detectPlatform, pickRelease, downloads } from './release.js';

const REPO = 'https://github.com/iignaite/Codemm';
const API = 'https://api.github.com/repos/iignaite/Codemm/releases?per_page=30';
const CACHE = 'codemm-releases';
const FRESH_MS = 10 * 60 * 1000;

const readCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE)); } catch { return null; }
};

/** The release list, or null if GitHub can't be reached and nothing is cached. */
async function loadReleases() {
  const cached = readCache();
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.releases;
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const releases = await res.json();
    try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), releases })); } catch {}
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
      el('p', { className: 'soon-title' }, 'Coming soon'),
      el('p', { className: 'note' }, 'The first beta is on its way. Follow the project on GitHub to hear when it\'s out.'),
      el('a', { className: 'btn secondary', href: REPO }, 'Follow on GitHub'))];
  }
  const parts = [];
  if (!d.primary) parts.push(el('p', { className: 'desktop-only' }, 'Codemm is a desktop app for a Mac or a Windows PC.'));
  if (d.primary) {
    parts.push(el('a', { className: 'btn primary', href: safe(d.primary.url) },
      el('span', { className: 'btn-label' }, d.primary.label),
      el('span', { className: 'btn-detail' }, d.primary.detail)));
  }
  const version = el('p', { className: 'version' }, 'Version ', el('code', {}, d.version));
  if (d.beta) version.append(el('span', { className: 'pill' }, 'Beta'), el('a', { href: '#first-launch' }, 'Opening a beta build'));
  parts.push(version);
  if (d.others.length) {
    const others = el('p', { className: 'others' }, el('span', {}, d.primary ? 'Also for' : 'Download for'));
    for (const o of d.others) others.append(el('a', { href: safe(o.url) }, o.name));
    parts.push(others);
  }
  return parts;
}

function render(d) {
  for (const box of document.querySelectorAll('[data-download]')) box.replaceChildren(...content(d));
  for (const note of document.querySelectorAll('[data-beta]')) note.hidden = !d.beta;
}

const [releases, p] = await Promise.all([loadReleases(), platform()]);
// Unknown (GitHub unreachable): keep the static link to the Releases page.
if (releases) render(downloads(pickRelease(releases), p));
