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
    const html = files.filter((f) => f.endsWith('.html')).sort();
    assert.deepEqual(html, ['index.html', 'tutors.html']);
    for (const name of html) {
      const p = readFileSync(join(out, name), 'utf8');
      // No forms or inputs, no inline code, and no tracking beyond Vercel Web Analytics
      // (cookieless, aggregate page views). No Speed Insights or other trackers.
      assert.doesNotMatch(p, /<form|<input|<textarea|speed-insights|gtag|googletagmanager|cookie/i, name);
      assert.deepEqual(p.match(/_vercel\/[a-z-]+\/script\.js/g), ['_vercel/insights/script.js'], name);
      assert.doesNotMatch(p, /<script(?![^>]*\b(src=|type="application\/ld\+json"))|\son[a-z]+=|style="/, name);
    }
    const page = readFileSync(join(out, 'index.html'), 'utf8');
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
    // The hero stays short: a headline, one line, the buttons and one note.
    assert.match(page, /<h1 id="title">Your coding agent, now your tutor\.<\/h1>\s*<p class="lead">It writes the exercises\. You write the code\.<\/p>/);
    assert.match(page, /id="get"[\s\S]*?<p class="hero-note">Free and open source\. Works with your coding agent\. <a href="#needs">What you need<\/a><\/p>\s*<\/div>/);
    // What you need names the agents and Docker.
    assert.match(page, /id="needs"[\s\S]*?Docker Desktop[\s\S]*?Claude Code, Codex or Cursor, signed in/);
    // The measured claim links to the results it comes from.
    assert.match(page, /turned away 17 bad exercises and setups across 12 runs[^<]*<a href="https:\/\/github\.com\/iignaite\/Codemm\/blob\/main\/docs\/bench\/results\.md">/);
    assert.match(page, /reject the incorrect versions your agent wrote/);
    assert.match(page, /with your own account/);
    // The launch video plays only when asked (no autoplay, nothing downloaded up front),
    // from this site, with a poster.
    assert.match(page, /<video [^>]*\bcontrols\b[^>]*\bpreload="none"[^>]*\bposter="\/video\/codemm-launch-poster\.jpg"/);
    assert.doesNotMatch(page, /\bautoplay\b/);
    assert.match(page, /<source src="\/video\/codemm-launch\.mp4" type="video\/mp4">/);
    for (const f of ['codemm-launch.mp4', 'codemm-launch-poster.jpg']) assert.ok(files.includes(join('video', f)), f);
    // The design rules allow no dots: no dotted or dashed strokes or borders.
    const css = readFileSync(join(out, 'styles.css'), 'utf8');
    assert.doesNotMatch(css, /stroke-dasharray|\b(dotted|dashed)\b/);
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('the tutor report card shows the hint round from the bench, with its limits', () => {
  const page = readFileSync(new URL('../public/tutors.html', import.meta.url), 'utf8');
  assert.match(page, /<h1 id="title">Which AI tutor gives away the answer\?<\/h1>/);
  // Rows come from docs/bench/results.md, "Tutor hints": first judge pass, shipped instructions.
  const rows = [...page.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)].map((m) => m.slice(1));
  assert.deepEqual(rows, [
    ['Claude Opus 5.5', 'No', '2 of 2'],
    ['gpt-6-astra', 'No', '2 of 2'],
    ['Claude Sonnet 5', 'No', '1 of 2'],
    ['gpt-5.6-luna', 'No', '1 of 2'],
    ['Claude Haiku 4.5', 'No', '3 of 6'],
  ]);
  assert.match(page, /gpt-6-astra pasted a working solution/);
  assert.match(page, /18 Oct 2026/);
  assert.match(page, /judged its own replies too/);
  assert.match(page, /<a href="https:\/\/github\.com\/iignaite\/Codemm\/blob\/main\/docs\/bench\/results\.md#tutor-hints-second-iteration-18-oct-2026">/);
  assert.match(page, /<link rel="canonical" href="%SITE_URL%\/tutors">/);
  assert.match(readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8'), /<loc>%SITE_URL%\/tutors<\/loc>/);
  // One primary action.
  assert.equal(page.match(/class="btn primary/g)?.length, 1);
});

test('Vercel serves files only, with a CSP that reaches only this site and GitHub', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions, undefined);
  assert.equal(existsSync(new URL('../api', import.meta.url)), false);
  const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.match(csp, /media-src 'self';/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});
