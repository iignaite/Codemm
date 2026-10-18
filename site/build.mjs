// Copies public/ to dist/ and fills in the site's absolute URL in every page, robots.txt and the sitemap,
// which the canonical link and Open Graph tags need. On Vercel it is the production
// domain; set SITE_URL to override it.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function siteUrl(env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return '';
}

export function build(out, env) {
  const src = fileURLToPath(new URL('public', import.meta.url));
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true });
  for (const page of readdirSync(out).filter((f) => /\.(html|txt|xml)$/.test(f))) {
    const file = join(out, page);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('%SITE_URL%', siteUrl(env)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = siteUrl(process.env);
  if (!url) console.warn('No SITE_URL or VERCEL_PROJECT_PRODUCTION_URL: the page uses relative URLs.');
  build(fileURLToPath(new URL('dist', import.meta.url)), process.env);
}
