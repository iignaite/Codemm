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

const file = (url) => url?.split('/').pop() ?? null;
const shape = (d) => ({
  buttons: d.buttons.map((b) => [b.os, file(b.url), Boolean(b.primary)]),
  intel: file(d.intel),
});

test('two buttons, Mac and Windows: a Mac whose chip is unknown gets Apple Silicon, with an Intel link', () => {
  // Safari and Firefox never report the chip, so Intel Macs need a visible way to their build.
  const d = downloads(release('v1.0.0-beta.1'), { os: 'mac', arch: null });
  assert.equal(d.status, 'ready');
  assert.equal(d.unsigned, true);
  assert.deepEqual(shape(d), {
    buttons: [['mac', 'Codemm-1.0.0-beta.1-mac-arm64.dmg', true], ['windows', 'Codemm-1.0.0-beta.1-win-x64.exe', false]],
    intel: 'Codemm-1.0.0-beta.1-mac-x64.dmg',
  });
  assert.deepEqual(d.buttons.map((b) => b.label), ['Download for Mac', 'Download for Windows']);
});

test('a Mac that reports its chip gets its own build, and no Intel link', () => {
  assert.deepEqual(shape(downloads(release('v1.0.0'), { os: 'mac', arch: 'arm' })), {
    buttons: [['mac', 'Codemm-1.0.0-mac-arm64.dmg', true], ['windows', 'Codemm-1.0.0-win-x64.exe', false]],
    intel: null,
  });
  assert.deepEqual(shape(downloads(release('v1.0.0'), { os: 'mac', arch: 'x86' })), {
    buttons: [['mac', 'Codemm-1.0.0-mac-x64.dmg', true], ['windows', 'Codemm-1.0.0-win-x64.exe', false]],
    intel: null,
  });
  assert.equal(downloads(release('v1.0.0'), { os: 'mac', arch: 'arm' }).unsigned, false);
});

test('Windows gets the Windows button first', () => {
  assert.deepEqual(shape(downloads(release('v1.0.0'), { os: 'windows', arch: null })), {
    buttons: [['windows', 'Codemm-1.0.0-win-x64.exe', true], ['mac', 'Codemm-1.0.0-mac-arm64.dmg', false]],
    intel: 'Codemm-1.0.0-mac-x64.dmg',
  });
  // A Windows PC's own chip says nothing about the visitor's Mac.
  assert.deepEqual(shape(downloads(release('v1.0.0'), { os: 'windows', arch: 'x86' })), {
    buttons: [['windows', 'Codemm-1.0.0-win-x64.exe', true], ['mac', 'Codemm-1.0.0-mac-arm64.dmg', false]],
    intel: 'Codemm-1.0.0-mac-x64.dmg',
  });
});

test('other devices get both buttons, neither highlighted', () => {
  assert.deepEqual(shape(downloads(release('v1.0.0'), { os: 'other', arch: null })), {
    buttons: [['mac', 'Codemm-1.0.0-mac-arm64.dmg', false], ['windows', 'Codemm-1.0.0-win-x64.exe', false]],
    intel: 'Codemm-1.0.0-mac-x64.dmg',
  });
});

test('a release missing installers offers what it has', () => {
  const onlyWindows = release('v1.0.0', { assets: [asset('Codemm-1.0.0-win-x64.exe'), asset('Codemm-1.0.0-win-x64.exe.blockmap')] });
  assert.deepEqual(shape(downloads(onlyWindows, { os: 'mac', arch: 'arm' })), { buttons: [['windows', 'Codemm-1.0.0-win-x64.exe', false]], intel: null });
  const onlyIntel = release('v1.0.0', { assets: [asset('Codemm-1.0.0-mac-x64.dmg')] });
  assert.deepEqual(shape(downloads(onlyIntel, { os: 'mac', arch: null })), { buttons: [['mac', 'Codemm-1.0.0-mac-x64.dmg', true]], intel: null });
});

test('every download link is the release asset itself, so GitHub counts each download', () => {
  const r = release('v1.0.0');
  const d = downloads(r, { os: 'mac', arch: null });
  const urls = [...d.buttons.map((b) => b.url), d.intel];
  assert.deepEqual(urls.sort(), r.assets.map((a) => a.browser_download_url).sort());
});
