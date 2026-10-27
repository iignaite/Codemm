// Downloads for Codemm's installers (DESIGN §3.1, §6.1). In the app they go through Electron's network stack, so the
// system's proxy and certificate store apply, as in a browser. Every redirect hop is checked before it is followed,
// and each download has a size cap. A download that stalls, or loses the network midway, counts as offline,
// however long it has run.
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { net } from 'electron';

export class OfflineError extends Error {}

/** A response: its status, its headers by lowercase name, and its body. */
export interface Got {
  status: number;
  header(name: string): string | undefined;
  body: Readable;
}

/** One GET whose every redirect `allowed` approves before it is followed. It rejects once `signal` aborts. */
export type Get = (url: string, allowed: (url: string) => boolean, signal: AbortSignal) => Promise<Got>;

const MAX_HOPS = 5;
/** Docker Desktop and the agents are well under 2 GB; anything bigger isn't them. */
const MAX_BYTES = 2 * 1024 ** 3;
/** No bytes for this long means the network is gone, however big the download. */
const IDLE_MS = 60_000;
const LEFT = 'The download left the vendor’s site.';
/** Statuses whose response has no body, which fetch's Response refuses one for. */
const NULL_BODY = new Set([204, 205, 304]);
/** Not Electron's browser user agent: cursor.com answers a browser with a web page, not its install script. */
const USER_AGENT = 'Codemm';
/** Node's and Chromium's names for a host that can't be reached. */
const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|CONNECTION_[A-Z_]+|NETWORK_[A-Z_]+|TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)\b/;

class TooLarge extends Error {
  constructor() {
    super('The download is larger than expected.');
  }
}

const why = (e: unknown) => `${(e as Error)?.message ?? e} ${(e as { cause?: { code?: string } })?.cause?.code ?? ''}`;

/** Saves `url` to `file`, reporting 0 to 1. Rejects with OfflineError when the network is gone, before or midway. */
export function downloader(get: Get, idleMs = IDLE_MS) {
  return async (url: string, file: string, progress: (fraction: number) => void, allowed: (url: string) => boolean, maxBytes = MAX_BYTES) => {
    const abort = new AbortController();
    let body: Readable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const stalled = new OfflineError('The download stalled.');
        // The body first: aborting the request ends it without an error, which would read as the disk failing.
        body?.destroy(stalled);
        abort.abort(stalled);
      }, idleMs);
    };
    quiet();
    try {
      let res: Got;
      try {
        res = await get(url, allowed, abort.signal);
      } catch (e) {
        throw abort.signal.aborted || NETWORK.test(why(e)) ? new OfflineError(why(e)) : e;
      }
      body = res.body;
      if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.header('content-length')) || 0;
      if (total > maxBytes) throw new TooLarge();
      let got = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          quiet();
          got += chunk.length;
          if (got > maxBytes) return done(new TooLarge());
          if (total) progress(Math.min(1, got / total));
          done(null, chunk);
        },
      });
      // The stream that fails first is the cause; the pipeline then fails the others with its error.
      let disk: boolean | undefined;
      body.once('error', () => (disk ??= false));
      const out = createWriteStream(file).once('error', () => (disk ??= true));
      try {
        await pipeline(body, count, out);
      } catch (e) {
        // Anything but the size cap or the disk is the network failing midway.
        throw e instanceof TooLarge || e instanceof OfflineError || disk ? e : new OfflineError(why(e));
      }
      progress(1);
    } finally {
      clearTimeout(timer);
      body?.destroy();
    }
  };
}

/** Electron's network stack, as Chromium uses it: the system's proxy settings and certificate store. */
export function electronGet(request: typeof net.request): Get {
  return (url, allowed, signal) =>
    new Promise((resolve, reject) => {
      if (!allowed(url)) return reject(new Error(LEFT));
      const req = request({ url, redirect: 'manual' });
      req.setHeader('User-Agent', USER_AGENT);
      let hops = 0;
      // A redirect not followed ends the request.
      req.on('redirect', (_status, _method, next) => {
        if (++hops > MAX_HOPS) reject(new Error('Too many redirects.'));
        else if (!allowed(next)) reject(new Error(LEFT));
        else req.followRedirect();
      });
      req.on('response', (res) => {
        const header = (name: string) => [res.headers[name]].flat()[0];
        resolve({ status: res.statusCode, header, body: res as unknown as Readable });
      });
      req.on('error', reject);
      // Electron's abort emits no error, so the answer is the reason it was aborted.
      signal.addEventListener('abort', () => (reject(signal.reason), req.abort()), { once: true });
      req.end();
    });
}

/**
 * Core's toolchain download (core §4.5) over Electron's network stack, shaped as the `fetch` core takes: a redirect
 * comes back unfollowed, as a 3xx with its location, for core to check each hop. Electron's own net.fetch can't do
 * that: with redirect "manual" it fails ("Redirect was cancelled").
 */
export function electronFetch(request: typeof net.request) {
  return (url: string, { signal }: { redirect: 'manual'; signal: AbortSignal }): Promise<Response> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const req = request({ url, redirect: 'manual' });
      req.setHeader('User-Agent', USER_AGENT);
      let body: Readable | undefined;
      req.on('redirect', (status, _method, next) => {
        resolve(new Response(null, { status, headers: { location: next } }));
        req.abort();
      });
      req.on('response', (res) => {
        // Never a throw from Electron's callback in the main process: what fetch can't build fails this request.
        try {
          body = res as unknown as Readable;
          if (res.statusCode < 200 || res.statusCode > 599) throw new Error(`The server answered with status ${res.statusCode}.`);
          // Header bytes arrive as UTF-8 text; fetch's headers hold bytes, as Electron's own net.fetch passes them.
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) for (const v of [value].flat()) headers.append(name, Buffer.from(v, 'utf8').toString('latin1'));
          if (NULL_BODY.has(res.statusCode)) {
            resolve(new Response(null, { status: res.statusCode, headers }));
            req.abort();
            return;
          }
          // A body core stops reading (a headers-only check, a refused answer) stops the request too.
          body.once('close', () => body?.readableEnded || req.abort());
          resolve(new Response(Readable.toWeb(body) as ReadableStream, { status: res.statusCode, headers }));
        } catch (e) {
          reject(e);
          req.abort();
        }
      });
      req.on('error', reject);
      // Electron's abort ends a started body without an error: fail it with the reason, so a short file never reads as whole.
      signal.addEventListener('abort', () => (reject(signal.reason), body?.destroy(signal.reason), req.abort()), { once: true });
      req.end();
    });
}

/** Node's own fetch, which ignores the system's proxy and certificate store: only the opt-in real tests use it. */
export const fetchGet: Get = async (start, allowed, signal) => {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!allowed(url)) throw new Error(LEFT);
    const res = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT } });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) {
      const body = res.body ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]);
      return { status: res.status, header: (name) => res.headers.get(name) ?? undefined, body };
    }
    await res.body?.cancel();
    url = new URL(next, url).toString();
  }
  throw new Error('Too many redirects.');
};
