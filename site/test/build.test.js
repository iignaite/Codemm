import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, siteUrl } from '../build.mjs';

test('the site URL comes from SITE_URL, then the Vercel production domain', () => {
  assert.equal(siteUrl({ SITE_URL: 'https://example.org/' }), 'https://example.org');
  assert.equal(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'codemm.example.org' }), 'https://codemm.example.org');
  assert.equal(siteUrl({}), '');
});

test('the build fills in every absolute URL', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'codemm-site-')), 'dist');
  try {
    build(out, { VERCEL_PROJECT_PRODUCTION_URL: 'codemm.example.org' });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.equal(html.includes('%SITE_URL%'), false);
    assert.match(html, /<meta property="og:image" content="https:\/\/codemm\.example\.org\/og\.png">/);
    assert.ok(readFileSync(join(out, 'release.js'), 'utf8').length > 0);
    assert.match(readFileSync(join(out, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/codemm\.example\.org\/<\/loc>/);
    assert.match(readFileSync(join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/codemm\.example\.org\/sitemap\.xml/);
    assert.match(html, /"@type":"SoftwareApplication".*"url":"https:\/\/codemm\.example\.org\/"/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('the site is static and collects nothing', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'codemm-site-')), 'dist');
  try {
    build(out, {});
    const files = readdirSync(out, { recursive: true }).map(String);
    const html = files.filter((f) => f.endsWith('.html'));
    assert.deepEqual(html, ['index.html']);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    // No forms or inputs, no analytics, no inline code.
    assert.doesNotMatch(page, /<form|<input|<textarea|_vercel\/|analytics|gtag|googletagmanager/i);
    assert.doesNotMatch(page, /<script(?![^>]*\b(src=|type="application\/ld\+json"))|\son[a-z]+=|style="/);
    // No third-party logos: the agents appear as plain text only.
    assert.equal(files.some((f) => f.includes('agents')), false);
    assert.match(page, />Claude Code<\/button>/);
    assert.match(page, /Codemm isn't affiliated with or endorsed by them\./);
    assert.match(page, /provided as is, without warranty/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('Vercel serves files only, with a CSP that reaches GitHub alone', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions, undefined);
  assert.equal(existsSync(new URL('../api', import.meta.url)), false);
  const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src https:\/\/api\.github\.com;/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});
