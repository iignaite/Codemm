// @vitest-environment node
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { downloader, electronFetch, electronGet, OfflineError, type Get } from './download';
import { tempDir } from './testing/temp';

const any = () => true;
const file = () => join(tempDir('codemm-download-'), 'file');
/** A server's answer: a status, headers and a body the test feeds. */
const answer = (body: Readable, status = 200, headers: Record<string, string> = {}): Get => async () => ({ status, header: (n) => headers[n], body });

describe('downloads (§3.1, §6.1)', () => {
  it('saves the body and reports progress from 0 to 1', async () => {
    const to = file();
    const seen: number[] = [];
    await downloader(answer(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 200, { 'content-length': '4' }))('https://x/f', to, (f) => seen.push(f), any);
    expect(readFileSync(to, 'utf8')).toBe('abcd');
    expect(seen).toEqual([0.5, 1, 1]);
  });

  it('is offline when the host cannot be reached, by Node’s or Chromium’s name for it', async () => {
    for (const error of [new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_NAME_NOT_RESOLVED'), Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })]) {
      const get: Get = async () => Promise.reject(error);
      await expect(downloader(get)('https://x/f', file(), () => undefined, any)).rejects.toBeInstanceOf(OfflineError);
    }
    // A certificate the system doesn't trust is not being offline.
    const cert: Get = async () => Promise.reject(new Error('net::ERR_CERT_AUTHORITY_INVALID'));
    await expect(downloader(cert)('https://x/f', file(), () => undefined, any)).rejects.not.toBeInstanceOf(OfflineError);
  });

  it('is offline when the network fails midway, however much has arrived', async () => {
    const body = new PassThrough();
    const saving = downloader(answer(body, 200, { 'content-length': '100' }))('https://x/f', file(), () => undefined, any);
    body.write('half');
    setTimeout(() => body.destroy(new Error('net::ERR_CONNECTION_RESET')), 10);
    await expect(saving).rejects.toBeInstanceOf(OfflineError);
  });

  it('has no total deadline, only one for silence: a stalled download is offline', async () => {
    let aborted = false;
    const body = new PassThrough();
    const get: Get = async (_url, _allowed, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return { status: 200, header: () => undefined, body };
    };
    const saving = downloader(get, 80)('https://x/f', file(), () => undefined, any);
    // Bytes keep coming for longer than the idle limit, then stop.
    for (let i = 0; i < 4; i++) {
      body.write('x');
      await new Promise((r) => setTimeout(r, 40));
    }
    await expect(saving).rejects.toBeInstanceOf(OfflineError);
    expect(aborted).toBe(true);
  });

  it('a host that never answers is offline too', async () => {
    const get: Get = (_url, _allowed, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(downloader(get, 30)('https://x/f', file(), () => undefined, any)).rejects.toBeInstanceOf(OfflineError);
  });

  it('refuses a failed request or one larger than expected, as a plain failure', async () => {
    await expect(downloader(answer(Readable.from([]), 503))('https://x/f', file(), () => undefined, any)).rejects.toThrow('HTTP 503');
    await expect(downloader(answer(Readable.from([]), 200, { 'content-length': '11' }))('https://x/f', file(), () => undefined, any, 10)).rejects.toThrow('larger');
    const big = downloader(answer(Readable.from([Buffer.alloc(6), Buffer.alloc(6)])))('https://x/f', file(), () => undefined, any, 10);
    await expect(big).rejects.toThrow('larger');
    await expect(big).rejects.not.toBeInstanceOf(OfflineError);
  });

  it('a disk that fails to save is not being offline', async () => {
    const saving = downloader(answer(Readable.from([Buffer.from('x')])))('https://x/f', join(tempDir('codemm-download-'), 'missing', 'file'), () => undefined, any);
    await expect(saving).rejects.toThrow(/ENOENT/);
    await expect(saving).rejects.not.toBeInstanceOf(OfflineError);
  });
});

/**
 * A stand-in for Electron's ClientRequest: the test plays its redirects and response. Like Electron's, abort() emits
 * 'abort' only, never 'error', and ends a response that has started without an error.
 */
class Request extends EventEmitter {
  followed = 0;
  aborted = false;
  ended = false;
  res?: Readable;
  constructor(readonly url: string) {
    super();
  }
  headers: Record<string, string> = {};
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  followRedirect() {
    this.followed++;
  }
  abort() {
    this.aborted = true;
    process.nextTick(() => this.emit('abort'));
    this.res?.destroy();
  }
  end() {
    this.ended = true;
  }
  respond(body: Readable, statusCode = 200, headers: Record<string, string> = {}) {
    this.res = body;
    this.emit('response', Object.assign(body, { statusCode, headers }));
  }
}

function electron() {
  const made: Request[] = [];
  const request = ((options: { url: string; redirect: string }) => {
    expect(options.redirect).toBe('manual');
    const r = new Request(options.url);
    made.push(r);
    return r;
  }) as unknown as Parameters<typeof electronGet>[0];
  return { get: electronGet(request), made };
}

describe("Electron's network stack: the system's proxy and certificates (§3.1)", () => {
  const docker = (url: string) => url.startsWith('https://desktop.docker.com/');

  it('follows a redirect only to an allowed host, checked before it is followed', async () => {
    const e = electron();
    const got = e.get('https://desktop.docker.com/a', docker, new AbortController().signal);
    const r = e.made[0];
    expect(r.ended).toBe(true);
    r.emit('redirect', 302, 'GET', 'https://desktop.docker.com/b', {});
    expect(r.followed).toBe(1);
    const body = Readable.from([]);
    r.respond(body, 200, { 'content-length': '0' });
    const res = await got;
    expect(res.status).toBe(200);
    expect(res.header('content-length')).toBe('0');
    expect(res.body).toBe(body);

    const away = electron();
    const left = away.get('https://desktop.docker.com/a', docker, new AbortController().signal);
    away.made[0].emit('redirect', 302, 'GET', 'https://evil.example/b', {});
    await expect(left).rejects.toThrow('left');
    expect(away.made[0].followed).toBe(0);
  });

  // Electron sends its browser user agent by default, and cursor.com answers a browser with a web page, not the script.
  it('names itself Codemm, not a browser, before the request is sent', () => {
    const e = electron();
    void e.get('https://desktop.docker.com/a', docker, new AbortController().signal);
    expect(e.made[0].headers).toEqual({ 'User-Agent': 'Codemm' });
  });

  it('never requests a disallowed first URL, and stops after five redirects', async () => {
    const e = electron();
    await expect(e.get('http://desktop.docker.com/a', docker, new AbortController().signal)).rejects.toThrow('left');
    expect(e.made).toEqual([]);

    const loop = electron();
    const got = loop.get('https://desktop.docker.com/a', docker, new AbortController().signal);
    for (let i = 0; i < 6; i++) loop.made[0].emit('redirect', 302, 'GET', 'https://desktop.docker.com/a', {});
    await expect(got).rejects.toThrow('redirects');
    expect(loop.made[0].followed).toBe(5);
  });

  it("passes on the request's own error, and aborts the request when told to", async () => {
    const failing = electron();
    const failed = failing.get('https://desktop.docker.com/a', docker, new AbortController().signal);
    failing.made[0].emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(failed).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED');

    const e = electron();
    const abort = new AbortController();
    const got = e.get('https://desktop.docker.com/a', docker, abort.signal);
    abort.abort(new Error('stalled'));
    expect(e.made[0].aborted).toBe(true);
    // Electron's abort says nothing more: the answer is the reason it was aborted.
    await expect(got).rejects.toThrow('stalled');
  });

  it('a request that never answers, or stalls midway, is offline rather than stuck', async () => {
    const silent = electron();
    await expect(downloader(silent.get, 50)('https://desktop.docker.com/a', file(), () => undefined, docker)).rejects.toBeInstanceOf(OfflineError);
    expect(silent.made[0].aborted).toBe(true);

    const stalls = electron();
    const saving = downloader(stalls.get, 50)('https://desktop.docker.com/a', file(), () => undefined, docker);
    const body = new PassThrough();
    stalls.made[0].respond(body, 200, { 'content-length': '100' });
    body.write('some');
    await expect(saving).rejects.toBeInstanceOf(OfflineError);
  });
});

describe("core's toolchain download over Electron's network stack (core §4.5)", () => {
  function electronAsFetch() {
    const made: Request[] = [];
    const request = ((options: { url: string; redirect: string }) => {
      expect(options.redirect).toBe('manual');
      const r = new Request(options.url);
      made.push(r);
      return r;
    }) as unknown as Parameters<typeof electronFetch>[0];
    return { fetch: electronFetch(request), made };
  }
  const init = () => ({ redirect: 'manual' as const, signal: new AbortController().signal });

  // net.fetch with redirect "manual" throws "Redirect was cancelled" (Electron 44), so core couldn't check each hop.
  it('hands a redirect back unfollowed, with its location, for core to check', async () => {
    const e = electronAsFetch();
    const got = e.fetch('https://github.com/a.zip', init());
    expect(e.made[0].headers).toEqual({ 'User-Agent': 'Codemm' });
    e.made[0].emit('redirect', 302, 'GET', 'http://mirror.example/a.zip', {});
    const res = await got;
    expect([res.status, res.headers.get('location')]).toEqual([302, 'http://mirror.example/a.zip']);
    expect(e.made[0].followed).toBe(0);
    expect(e.made[0].aborted).toBe(true);
  });

  it('answers with the status, headers and body', async () => {
    const e = electronAsFetch();
    const got = e.fetch('https://github.com/a.zip', init());
    e.made[0].respond(Readable.from([Buffer.from('zip '), Buffer.from('bytes')]), 200, { 'content-type': 'application/zip' });
    const res = await got;
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'application/zip']);
    expect(await res.text()).toBe('zip bytes');
  });

  it("passes on the request's error, and an abort fails the request or the body midway with its reason", async () => {
    const failing = electronAsFetch();
    const failed = failing.fetch('https://github.com/a.zip', init());
    failing.made[0].emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED'));
    await expect(failed).rejects.toThrow('net::ERR_PROXY_CONNECTION_FAILED');

    const early = electronAsFetch();
    const stop = new AbortController();
    const waiting = early.fetch('https://github.com/a.zip', { redirect: 'manual', signal: stop.signal });
    stop.abort(new Error('stalled'));
    await expect(waiting).rejects.toThrow('stalled');
    expect(early.made[0].aborted).toBe(true);

    const midway = electronAsFetch();
    const later = new AbortController();
    const got = midway.fetch('https://github.com/a.zip', { redirect: 'manual', signal: later.signal });
    const body = new PassThrough();
    midway.made[0].respond(body, 200);
    const res = await got;
    body.write('some');
    const reading = res.arrayBuffer();
    later.abort(new Error('stalled'));
    // Never a short file that reads as complete: the body fails, so a stall isn't a digest mismatch.
    await expect(reading).rejects.toThrow('stalled');
  });
});
