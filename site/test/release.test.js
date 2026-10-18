import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, pickRelease, downloads } from '../public/release.js';

const UA = {
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

test('detects a Mac, with the architecture only when the browser reports it', () => {
  assert.deepEqual(detectPlatform({ userAgent: UA.macSafari }), { os: 'mac', arch: null });
  assert.deepEqual(detectPlatform({ userAgent: UA.macChrome, uaPlatform: 'macOS', architecture: 'arm' }), { os: 'mac', arch: 'arm' });
  assert.deepEqual(detectPlatform({ userAgent: UA.macChrome, uaPlatform: 'macOS', architecture: 'x86' }), { os: 'mac', arch: 'x86' });
});

test('detects Windows', () => {
  assert.deepEqual(detectPlatform({ userAgent: UA.windows }), { os: 'windows', arch: null });
  assert.deepEqual(detectPlatform({ userAgent: UA.windows, uaPlatform: 'Windows', architecture: 'x86' }), { os: 'windows', arch: 'x86' });
});

test('phones, tablets and Linux have no installer', () => {
  assert.equal(detectPlatform({ userAgent: UA.iphone }).os, 'other');
  assert.equal(detectPlatform({ userAgent: UA.android, uaPlatform: 'Android' }).os, 'other');
  assert.equal(detectPlatform({ userAgent: UA.linux }).os, 'other');
  // iPadOS Safari reports itself as a Mac; only touch support gives it away.
  assert.equal(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 }).os, 'other');
  assert.equal(detectPlatform({}).os, 'other');
});

const asset = (name) => ({ name, browser_download_url: `https://github.com/iignaite/Codemm/releases/download/x/${name}` });
const release = (tag, o = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-'),
  published_at: o.at ?? '2026-11-01T00:00:00Z',
  html_url: `https://github.com/iignaite/Codemm/releases/tag/${tag}`,
  assets: o.assets ?? [
    asset(`Codemm-${tag.slice(1)}-mac-arm64.dmg`),
    asset(`Codemm-${tag.slice(1)}-mac-x64.dmg`),
    asset(`Codemm-${tag.slice(1)}-win-x64.exe`),
  ],
});

test('picks the newest stable release over a newer beta', () => {
  const r = pickRelease([
    release('v1.1.0-beta.1', { at: '2026-12-01T00:00:00Z' }),
    release('v1.0.0', { at: '2026-11-01T00:00:00Z' }),
    release('v1.0.0-beta.2', { at: '2026-10-01T00:00:00Z' }),
  ]);
  assert.equal(r.tag_name, 'v1.0.0');
});

test('picks the newest beta while there is no stable release', () => {
  const r = pickRelease([
    release('v1.0.0-beta.1', { at: '2026-10-01T00:00:00Z' }),
    release('v1.0.0-beta.2', { at: '2026-10-20T00:00:00Z' }),
  ]);
  assert.equal(r.tag_name, 'v1.0.0-beta.2');
});

test('ignores drafts and releases with no installers', () => {
  const draft = { ...release('v1.0.0'), draft: true };
  const empty = release('v1.0.1', { at: '2026-12-01T00:00:00Z', assets: [asset('notes.txt')] });
  assert.equal(pickRelease([draft, empty]), null);
  assert.equal(pickRelease([]), null);
  assert.equal(pickRelease(null), null);
  assert.equal(pickRelease({ message: 'API rate limit exceeded' }), null);
});

test('no published release means coming soon', () => {
  assert.deepEqual(downloads(null, { os: 'mac', arch: null }), { status: 'soon' });
});

const byId = (d) => [d.primary?.id, ...d.others.map((o) => o.id)];

test('a Mac with an unknown chip gets Apple Silicon first and Intel next', () => {
  const d = downloads(release('v1.0.0-beta.1'), { os: 'mac', arch: null });
  assert.equal(d.status, 'ready');
  assert.equal(d.version, '1.0.0-beta.1');
  assert.equal(d.beta, true);
  assert.deepEqual(byId(d), ['mac-arm64', 'mac-x64', 'win-x64']);
  assert.equal(d.primary.url, 'https://github.com/iignaite/Codemm/releases/download/x/Codemm-1.0.0-beta.1-mac-arm64.dmg');
});

test('an Intel Mac gets the Intel build first', () => {
  const d = downloads(release('v1.0.0'), { os: 'mac', arch: 'x86' });
  assert.equal(d.beta, false);
  assert.deepEqual(byId(d), ['mac-x64', 'mac-arm64', 'win-x64']);
});

test('Windows gets the Windows installer first', () => {
  const d = downloads(release('v1.0.0'), { os: 'windows', arch: null });
  assert.deepEqual(byId(d), ['win-x64', 'mac-arm64', 'mac-x64']);
  assert.equal(d.primary.url.endsWith('win-x64.exe'), true);
});

test('other devices get no primary button, and every installer listed', () => {
  const d = downloads(release('v1.0.0'), { os: 'other', arch: null });
  assert.equal(d.primary, null);
  assert.deepEqual(d.others.map((o) => o.id), ['mac-arm64', 'mac-x64', 'win-x64']);
});

test('a release missing the matching installer offers what it has', () => {
  const r = release('v1.0.0', { assets: [asset('Codemm-1.0.0-win-x64.exe'), asset('Codemm-1.0.0-win-x64.exe.blockmap')] });
  const d = downloads(r, { os: 'mac', arch: 'arm' });
  assert.equal(d.primary, null);
  assert.deepEqual(d.others.map((o) => o.id), ['win-x64']);
});

test('every download button is the release asset itself, so GitHub counts each download', () => {
  const r = release('v1.0.0');
  const d = downloads(r, { os: 'mac', arch: null });
  const urls = [d.primary.url, ...d.others.map((o) => o.url)];
  assert.deepEqual(urls.sort(), r.assets.map((a) => a.browser_download_url).sort());
});
