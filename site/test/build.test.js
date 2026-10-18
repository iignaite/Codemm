import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // Without its script, the form must never submit the email in a URL.
    assert.match(html, /<form class="gate" id="get" method="post" action="\/api\/subscribe"/);
    assert.match(html, /id="gate-submit" type="submit" disabled>/);
    for (const page of ['index.html', 'downloads.html', 'unsubscribe.html']) {
      assert.doesNotMatch(readFileSync(join(out, page), 'utf8'), /<script(?![^>]*\bsrc=)|\son[a-z]+=|style="/, page);
    }
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});
