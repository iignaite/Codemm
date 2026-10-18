// A local stand-in for Vercel: serves dist/ with clean URLs and vercel.json's
// headers, and routes /api/<name> to api/<name>.js. No Vercel account needed.
// Usage: npm run build && node --env-file=.env scripts/dev.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const port = Number(process.env.PORT ?? 4317);
// DEV_RELEASES_FILE stands in for GitHub's release list, to preview a release before one exists.
if (process.env.DEV_RELEASES_FILE) {
  const fixture = await readFile(process.env.DEV_RELEASES_FILE, 'utf8');
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith('https://api.github.com/') ? Promise.resolve(new Response(fixture)) : real(url, init);
}
const config = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const headersFor = (path) => config.headers
  .filter((h) => new RegExp(`^${h.source.replace(/\(\.\*\)/g, '.*')}$`).test(path))
  .flatMap((h) => h.headers.map((x) => [x.key, x.value]));

async function api(name, req, url) {
  const mod = await import(join(root, 'api', `${name}.js`)).catch(() => null);
  const handler = mod?.[req.method];
  if (!handler) return new Response('Not found', { status: 404 });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
  headers.set('x-real-ip', req.socket.remoteAddress ?? 'unknown');
  return handler(new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
}

createServer((req, res) => serve(req, res).catch(() => {
  if (!res.headersSent) res.writeHead(400);
  res.end('Bad request');
})).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));

async function serve(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
  const extra = headersFor(url.pathname);
  const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
  if (m) {
    const r = await api(m[1], req, url);
    res.writeHead(r.status, Object.fromEntries([...extra, ...r.headers]));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  if (!extname(path)) path += '.html';
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, Object.fromEntries([...extra, ['content-type', TYPES[extname(path)] ?? 'application/octet-stream']]));
    res.end(body);
  } catch {
    res.writeHead(404, Object.fromEntries(extra));
    res.end('Not found');
  }
}
