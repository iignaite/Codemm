// The email gate's four endpoints, as (Request) => Response. Dependencies are
// passed in so tests can use an in-memory database, a fake clock and fake releases.
import { createHmac } from 'node:crypto';
import { normalizeEmail } from './email.js';
import { keyedHash, sign, verify } from './tokens.js';
import { pickRelease } from '../public/release.js';

/** The Terms of Use version on public/terms.html. Change both together, and keep old versions in git. */
export const TERMS_VERSION = '2026-10-18';

export const LIMITS = {
  ip: { max: 5, windowMs: 10 * 60 * 1000 },
  email: { max: 3, windowMs: 60 * 60 * 1000 },
  unsubscribe: { max: 10, windowMs: 10 * 60 * 1000 },
};
const FORM_MIN_MS = 3000;            // faster than a person fills the form
const FORM_MAX_MS = 2 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 2048;
const INSTALLER = /\.(dmg|exe)$/i;

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// One key per purpose, derived from the one server secret.
const subkey = (secret, purpose) => createHmac('sha256', secret).update(`codemm-site:${purpose}`).digest();

/**
 * @param {{ db: import('@libsql/client').Client, secret: string, now: () => number, releases: () => Promise<any[]> }} deps
 */
export function createApp({ db, secret, now, releases }) {
  const configured = typeof secret === 'string' && secret.length >= 32;
  const keys = configured && {
    form: subkey(secret, 'form'), download: subkey(secret, 'download'),
    unsubscribe: subkey(secret, 'unsubscribe'), limit: subkey(secret, 'rate-limit'),
    suppress: subkey(secret, 'suppression'),
  };

  async function readJson(request) {
    if (request.method !== 'POST') throw new Refusal(405, 'Use POST.');
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new Refusal(403, 'Not allowed.');
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON.');
    if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Refusal(413, 'Too large.');
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Refusal(413, 'Too large.');
    try {
      const body = JSON.parse(text);
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch {}
    throw new Refusal(400, 'Something went wrong. Try again.');
  }

  /** Counts one request against a fixed window; refuses once over the limit. */
  async function limit(kind, value) {
    const { max, windowMs } = LIMITS[kind];
    const t = now();
    const { rows } = await db.execute({
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
            ON CONFLICT (key) DO UPDATE SET
              count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
              window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [`${kind}:${keyedHash(keys.limit, value)}`, t, t - windowMs, t - windowMs],
    });
    if (Number(rows[0].count) > max) throw new Refusal(429, 'Too many tries. Wait a few minutes and try again.');
  }

  const ip = (request) => request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

  /** Wraps a handler: refusals become their status; anything else is logged without details and becomes a 500. */
  const handle = (name, fn) => async (request) => {
    if (!configured) return json(500, { error: 'The site isn\'t configured yet.' });
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, { error: e.message });
      console.error(`codemm-site ${name} failed: ${e?.code ?? e?.name ?? 'error'}`);
      return json(500, { error: 'Something went wrong. Try again.' });
    }
  };

  async function latest() {
    try {
      const release = pickRelease(await releases());
      if (!release) return null;
      const { tag_name, prerelease, published_at, html_url } = release;
      const assets = release.assets.filter((a) => INSTALLER.test(a.name)).map(({ name, browser_download_url }) => ({ name, browser_download_url }));
      return { tag_name, prerelease, published_at, html_url, assets };
    } catch {
      return undefined; // GitHub unreachable
    }
  }

  return {
    /** GET: a form token (for the time-to-submit check) and whether a release is out. */
    form: handle('form', async (request) => {
      if (request.method !== 'GET') throw new Refusal(405, 'Use GET.');
      const release = await latest();
      return json(200, {
        token: sign(keys.form, { p: 'form', iat: now() }),
        available: release === undefined ? null : Boolean(release),
        version: release ? release.tag_name.replace(/^v/, '') : null,
        beta: release ? release.prerelease : null,
      });
    }),

    /** POST { email, token, company, terms, updates }: stores the email, release-email choice and Terms version; returns a download token. */
    subscribe: handle('subscribe', async (request) => {
      const body = await readJson(request);
      if (body.company) throw new Refusal(400, 'Something went wrong. Try again.'); // honeypot
      const form = verify(keys.form, body.token, 'form', now());
      const age = form && now() - form.iat;
      if (!form || !(age >= FORM_MIN_MS && age <= FORM_MAX_MS)) throw new Refusal(400, 'Something went wrong. Reload the page and try again.');
      await limit('ip', ip(request));
      const email = normalizeEmail(body.email);
      if (!email) throw new Refusal(400, 'Enter a valid email address.');
      if (body.terms !== true) throw new Refusal(400, 'Agree to the Terms to continue.');
      const consent = body.updates === true ? 1 : 0;
      await limit('email', email);
      const t = now();
      // An email that unsubscribed stays off the list; the answer is the same either way.
      await db.execute({
        sql: `INSERT INTO subscribers (email, consent, created_at, terms_version)
              SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM suppressions WHERE email_hash = ?)
              ON CONFLICT (email) DO UPDATE SET consent = excluded.consent, terms_version = excluded.terms_version`,
        args: [email, consent, t, TERMS_VERSION, keyedHash(keys.suppress, email)],
      });
      await db.execute({ sql: 'DELETE FROM rate_limits WHERE window_start < ?', args: [t - 24 * 60 * 60 * 1000] });
      // No unsubscribe token here: whoever submits an email hasn't shown they own it.
      // Unsubscribe links go only to the inbox, in the owner's emails (scripts/unsubscribe-link.mjs).
      return json(200, { download: sign(keys.download, { p: 'dl', exp: t + DOWNLOAD_TTL_MS }) });
    }),

    /** GET with "Authorization: Bearer <download token>": the release's installers. */
    downloads: handle('downloads', async (request) => {
      if (request.method !== 'GET') throw new Refusal(405, 'Use GET.');
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
      if (!verify(keys.download, token, 'dl', now())) throw new Refusal(401, 'This link has expired. Enter your email again.');
      const release = await latest();
      if (release === undefined) throw new Refusal(503, 'Couldn\'t reach GitHub. Try again in a minute.');
      return json(200, { release });
    }),

    /** POST { token }: deletes the subscriber and keeps a keyed hash so the email can't be re-added. Idempotent. */
    unsubscribe: handle('unsubscribe', async (request) => {
      const body = await readJson(request);
      await limit('unsubscribe', ip(request));
      const payload = verify(keys.unsubscribe, body.token, 'unsub', now());
      if (!payload || !Number.isSafeInteger(payload.id)) throw new Refusal(400, 'This link isn\'t valid.');
      const { rows } = await db.execute({ sql: 'SELECT email FROM subscribers WHERE id = ?', args: [payload.id] });
      if (rows.length) {
        await db.batch([
          { sql: 'INSERT OR IGNORE INTO suppressions (email_hash, created_at) VALUES (?, ?)', args: [keyedHash(keys.suppress, String(rows[0].email)), now()] },
          { sql: 'DELETE FROM subscribers WHERE id = ?', args: [payload.id] },
        ], 'write');
      }
      return json(200, { ok: true });
    }),
  };
}

/** For the owner's release emails: the unsubscribe token for a subscriber id. */
export const unsubscribeTokenFor = (secret, id) => sign(subkey(secret, 'unsubscribe'), { p: 'unsub', id });
