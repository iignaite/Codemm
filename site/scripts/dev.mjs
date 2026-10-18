// A local stand-in for Vercel: serves dist/ with clean URLs and vercel.json's
// headers. No Vercel account needed.
// Usage: npm run build && npm run dev
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const port = Number(process.env.PORT ?? 4317);
const config = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml' };

const headersFor = (path) => config.headers
  .filter((h) => new RegExp(`^${h.source.replace(/\(\.\*\)/g, '.*')}$`).test(path))
  .flatMap((h) => h.headers.map((x) => [x.key, x.value]));

createServer((req, res) => serve(req, res).catch(() => {
  if (!res.headersSent) res.writeHead(400);
  res.end('Bad request');
})).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));

async function serve(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
  const extra = headersFor(url.pathname);
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
