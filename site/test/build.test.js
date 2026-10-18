import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, siteUrl } from '../build.mjs';
import { TERMS_VERSION } from '../lib/app.js';

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
    for (const page of ['index.html', 'downloads.html', 'unsubscribe.html', 'terms.html']) {
      assert.doesNotMatch(readFileSync(join(out, page), 'utf8'), /<script(?![^>]*\b(src=|type="application\/ld\+json"))|\son[a-z]+=|style="/, page);
    }
    // The unsubscribe page keeps its token in the address, so it loads no analytics.
    assert.doesNotMatch(readFileSync(join(out, 'unsubscribe.html'), 'utf8'), /_vercel\/insights/);
    // On the downloads page, analytics loads after the script that strips the token from the address.
    const dl = readFileSync(join(out, 'downloads.html'), 'utf8');
    assert.ok(dl.indexOf('/downloads.js') < dl.indexOf('/_vercel/insights/script.js'));
    assert.match(readFileSync(join(out, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/codemm\.example\.org\/<\/loc>/);
    assert.match(readFileSync(join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/codemm\.example\.org\/sitemap\.xml/);
    assert.match(html, /"@type":"SoftwareApplication".*"url":"https:\/\/codemm\.example\.org\/"/);
    // Clickwrap: the Terms box is required and unticked, the release-email box is optional and unticked.
    assert.match(html, /<input id="terms" name="terms" type="checkbox" required>/);
    assert.match(html, /<input id="updates" name="updates" type="checkbox">/);
    assert.doesNotMatch(html, /checked/);
    // The Terms page shows the version the server records.
    assert.match(readFileSync(join(out, 'terms.html'), 'utf8'), new RegExp(`Version ${TERMS_VERSION}\\.`));
    assert.match(readFileSync(join(out, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/codemm\.example\.org\/terms<\/loc>/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});
