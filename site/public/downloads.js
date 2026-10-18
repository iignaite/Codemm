// The downloads page: unlocked by the download token from the email gate.
import { detectPlatform, downloads } from './release.js';

const KEY = 'codemm-gate';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
// Only ever link to GitHub.
const safe = (url) => (typeof url === 'string' && url.startsWith('https://github.com/') ? url : 'https://github.com/iignaite/Codemm');

/** The download token from the fragment (then removed from the address bar), or from this tab's session. */
function tokens() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('d')) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ d: hash.get('d') })); } catch {}
    history.replaceState(null, '', location.pathname);
    return { d: hash.get('d') };
  }
  try { return JSON.parse(sessionStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

async function platform() {
  const ua = navigator.userAgentData;
  let architecture = '';
  try { architecture = (await ua?.getHighEntropyValues(['architecture']))?.architecture ?? ''; } catch {}
  return detectPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, uaPlatform: ua?.platform, architecture });
}

function show(title, lead, ...actions) {
  $('dl-title').textContent = title;
  $('dl-lead').textContent = lead;
  $('dl').replaceChildren(...actions);
}

function render(d) {
  if (d.status === 'soon') return show('Coming soon.', 'You\'re on the list. We\'ll email you when the first beta is out.');
  const parts = [];
  if (d.primary) {
    parts.push(el('a', { className: 'btn primary big', href: safe(d.primary.url) },
      el('span', { className: 'btn-label' }, d.primary.label),
      el('span', { className: 'btn-detail' }, d.primary.detail)));
  } else {
    parts.push(el('p', { className: 'desktop-only' }, 'Codemm is a desktop app for a Mac or a Windows PC.'));
  }
  const version = el('p', { className: 'version' }, 'Version ', el('code', {}, d.version));
  if (d.beta) version.append(el('span', { className: 'pill' }, 'Beta'));
  parts.push(version);
  if (d.others.length) {
    const others = el('p', { className: 'others' }, el('span', {}, d.primary ? 'Also for' : 'Download for'));
    for (const o of d.others) others.append(el('a', { href: safe(o.url) }, o.name));
    parts.push(others);
  }
  show('Download Codemm', 'Thanks for signing up. Here\'s the installer for your computer.', ...parts);
  $('after').hidden = false;
  document.querySelector('[data-beta]').hidden = !d.beta;
}

const { d } = tokens();
const expired = () => show('This link has expired.', 'Download links last 10 minutes. Enter your email again for a new one.', el('a', { className: 'btn primary big', href: '/#get' }, 'Get a new link'));

if (!d) {
  expired();
} else {
  try {
    const [res, p] = await Promise.all([fetch('/api/downloads', { headers: { authorization: `Bearer ${d}` }, cache: 'no-store' }), platform()]);
    if (res.status === 401) expired();
    else if (!res.ok) show('GitHub isn\'t answering.', 'The installers are hosted on GitHub. Try again in a minute.', el('a', { className: 'btn primary big', href: '/downloads' }, 'Try again'));
    else render(downloads((await res.json()).release, p));
  } catch {
    show('Couldn\'t reach Codemm.', 'Check your connection and try again.', el('a', { className: 'btn primary big', href: '/downloads' }, 'Try again'));
  }
}
