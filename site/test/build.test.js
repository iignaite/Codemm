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

test('the site is static and collects no personal data', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'codemm-site-')), 'dist');
  try {
    build(out, {});
    const files = readdirSync(out, { recursive: true }).map(String);
    const html = files.filter((f) => f.endsWith('.html'));
    assert.deepEqual(html, ['index.html']);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    // No forms or inputs, no inline code, and no tracking beyond Vercel Web Analytics
    // (cookieless, aggregate page views). No Speed Insights or other trackers.
    assert.doesNotMatch(page, /<form|<input|<textarea|speed-insights|gtag|googletagmanager|cookie/i);
    assert.deepEqual(page.match(/_vercel\/[a-z-]+\/script\.js/g), ['_vercel/insights/script.js']);
    assert.doesNotMatch(page, /<script(?![^>]*\b(src=|type="application\/ld\+json"))|\son[a-z]+=|style="/);
    // The agents' logos, by the owner's choice, each named for screen readers, and the
    // footer still says they're trademarks of their owners.
    for (const [name, file] of [['Claude Code', 'claude'], ['Codex', 'codex'], ['Cursor', 'cursor']]) {
      assert.ok(files.includes(join('img', 'agents', `${file}.svg`)), file);
      // lobe-icons is MIT: its notice ships with the copies.
      assert.match(readFileSync(join(out, 'img', 'agents', 'LICENSE-lobe-icons.txt'), 'utf8'), /Copyright \(c\) 2023 LobeHub[\s\S]*Permission is hereby granted/);
      assert.match(page, new RegExp(`aria-label="${name}"><img src="/img/agents/${file}\\.svg" alt=""`));
    }
    assert.match(page, /Codemm isn't affiliated with or endorsed by them\./);
    assert.match(page, /provided as is, without warranty/);
    // Downloads are two buttons, Mac and Windows, with no Beta label (the owner's choice).
    assert.doesNotMatch(page + readFileSync(join(out, 'main.js'), 'utf8'), /\bbeta\b/i);
    // Say only what Codemm checks: exercises against their tests, which must reject the
    // incorrect versions the agent wrote. Lessons aren't checked, and nothing is "proven".
    assert.doesNotMatch(page, /\bprove[ns]?\b|\bproof that\b|every broken|own plan|guarantee/i);
    assert.match(page, /<p class="lead">Your agent writes the learning path\. Codemm grades you\.<\/p>/);
    assert.match(page, /reject the incorrect versions your agent wrote/);
    assert.match(page, /with your own account/);
    // The design rules allow no dots: no dotted or dashed strokes or borders.
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    assert.doesNotMatch(css, /stroke-dasharray|\b(dotted|dashed)\b/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('Vercel serves files only, with a CSP that reaches only this site and GitHub', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions, undefined);
  assert.equal(existsSync(new URL('../api', import.meta.url)), false);
  const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});
