import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { createApp, LIMITS, unsubscribeTokenFor } from '../lib/app.js';
import { migrate } from '../lib/db.js';
import { normalizeEmail } from '../lib/email.js';
import { sign, verify } from '../lib/tokens.js';

const SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const ORIGIN = 'https://codemm.example.org';
const asset = (n) => ({ name: n, browser_download_url: `https://github.com/iignaite/Codemm/releases/download/v1.0.0-beta.1/${n}`, size: 1, id: 7 });
const RELEASES = [{
  tag_name: 'v1.0.0-beta.1', draft: false, prerelease: true, published_at: '2026-10-20T00:00:00Z',
  html_url: 'https://github.com/iignaite/Codemm/releases/tag/v1.0.0-beta.1', body: 'notes',
  assets: [asset('Codemm-1.0.0-beta.1-mac-arm64.dmg'), asset('Codemm-1.0.0-beta.1-win-x64.exe'), asset('Codemm-1.0.0-beta.1-win-x64.exe.blockmap')],
}];

let db, clock, app;
beforeEach(async () => {
  db = createClient({ url: ':memory:' });
  await migrate(db);
  clock = { t: Date.parse('2026-10-18T12:00:00Z') };
  app = createApp({ db, secret: SECRET, now: () => clock.t, releases: async () => RELEASES });
});

const req = (path, { method = 'GET', body, ip = '203.0.113.7', headers = {} } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'x-real-ip': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

async function formToken() {
  const res = await app.form(req('/api/form'));
  return (await res.json()).token;
}
async function subscribe(email, o = {}) {
  const token = o.token ?? (await formToken());
  clock.t += o.wait ?? 5000;
  const res = await app.subscribe(req('/api/subscribe', { method: 'POST', ip: o.ip, headers: o.headers, body: { email, token, company: o.honeypot ?? '' } }));
  return { status: res.status, body: await res.json() };
}
const rows = async () => (await db.execute('SELECT * FROM subscribers ORDER BY id')).rows;

/* Email validation */

test('emails are trimmed, lowercased and checked for length and format', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace+codemm@Example.ORG '), 'ada.lovelace+codemm@example.org');
  assert.equal(normalizeEmail("o'brien@example.ie"), "o'brien@example.ie");
  for (const bad of ['', 'no-at.example.org', 'a@b', 'a@b.c', '.a@example.org', 'a.@example.org', 'a..b@example.org',
    'a@-example.org', 'a@example-.org', 'a@exa_mple.org', 'a b@example.org', 'ä@example.org', 'a@exam\nple.org',
    'a@example.org\r\nBcc: x@example.org', `${'a'.repeat(65)}@example.org`, `a@${'b'.repeat(250)}.org`, null, 42, ['a@example.org'], { email: 'a@example.org' }]) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
});

test('injection attempts are rejected by validation, and a valid quote is stored safely', async () => {
  for (const evil of ["a@example.org'; DROP TABLE subscribers;--", "x' OR '1'='1@example.org", 'a@example.org" --', '<script>@example.org']) {
    assert.equal((await subscribe(evil, { ip: `198.51.100.${evil.length}` })).status, 400);
  }
  assert.equal((await subscribe("o'brien@example.ie")).status, 200);
  assert.deepEqual((await rows()).map((r) => r.email), ["o'brien@example.ie"]);
});

/* Subscribing */

test('a valid submit stores only the email, a consent flag and a timestamp', async () => {
  const { status, body } = await subscribe('Ada@Example.org');
  assert.equal(status, 200);
  assert.equal(typeof body.download, 'string');
  assert.deepEqual(Object.keys(body), ['download']);
  const cols = (await db.execute('PRAGMA table_info(subscribers)')).rows.map((r) => r.name);
  assert.deepEqual(cols, ['id', 'email', 'consent', 'created_at']);
  const [row] = await rows();
  assert.equal(row.email, 'ada@example.org');
  assert.equal(row.consent, 1);
  assert.equal(row.created_at, clock.t);
});

test('subscribing twice keeps one row and the same answer', async () => {
  const a = await subscribe('ada@example.org');
  const b = await subscribe('ADA@example.org');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await rows()).length, 1);
});

test('the honeypot rejects', async () => {
  const { status } = await subscribe('ada@example.org', { honeypot: 'Acme Inc' });
  assert.equal(status, 400);
  assert.equal((await rows()).length, 0);
});

test('a submit faster than a person could type is rejected', async () => {
  const { status } = await subscribe('ada@example.org', { wait: 500 });
  assert.equal(status, 400);
  assert.equal((await rows()).length, 0);
});

test('a stale or forged form token is rejected', async () => {
  assert.equal((await subscribe('ada@example.org', { wait: 3 * 60 * 60 * 1000 })).status, 400);
  const forged = sign('wrong-secret-that-is-also-long-enough-x', { p: 'form', iat: clock.t - 10_000 });
  assert.equal((await subscribe('ada@example.org', { token: forged })).status, 400);
  assert.equal((await rows()).length, 0);
});

test('requests from another origin, bad JSON or oversized bodies are rejected', async () => {
  assert.equal((await subscribe('ada@example.org', { headers: { origin: 'https://evil.example' } })).status, 403);
  const post = (body, headers = {}) => app.subscribe(req('/api/subscribe', { method: 'POST', body, headers }));
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post(JSON.stringify({ email: 'a@example.org', pad: 'x'.repeat(4000) }))).status, 413);
  assert.equal((await post('email=a@example.org', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await app.subscribe(req('/api/subscribe'))).status, 405);
  assert.equal((await rows()).length, 0);
});

/* Rate limits */

test('one IP is limited across emails', async () => {
  for (let i = 0; i < LIMITS.ip.max; i++) assert.equal((await subscribe(`p${i}@example.org`)).status, 200);
  const blocked = await subscribe('one-more@example.org');
  assert.equal(blocked.status, 429);
  assert.equal((await subscribe('other@example.org', { ip: '203.0.113.99' })).status, 200);
  clock.t += LIMITS.ip.windowMs;
  assert.equal((await subscribe('later@example.org')).status, 200);
});

test('one email is limited across IPs', async () => {
  for (let i = 0; i < LIMITS.email.max; i++) assert.equal((await subscribe('ada@example.org', { ip: `192.0.2.${i}` })).status, 200);
  assert.equal((await subscribe('ada@example.org', { ip: '192.0.2.200' })).status, 429);
});

test('rate limits store no IP or email', async () => {
  await subscribe('ada@example.org');
  const keys = (await db.execute('SELECT key FROM rate_limits')).rows.map((r) => r.key).join(' ');
  assert.ok(!keys.includes('203.0.113.7'));
  assert.ok(!keys.includes('ada'));
});

test('emails are never logged', async () => {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.map(String).join(' '));
  try {
    await subscribe('secret.person@example.org');
    db.close();
    await subscribe('secret.person@example.org', { ip: '192.0.2.9' });
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!seen.join('\n').includes('secret.person'));
});

/* Tokens and downloads */

test('a download token unlocks the release, trimmed to its installers', async () => {
  const { body } = await subscribe('ada@example.org');
  const res = await app.downloads(req('/api/downloads', { headers: { authorization: `Bearer ${body.download}` } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { release } = await res.json();
  assert.equal(release.tag_name, 'v1.0.0-beta.1');
  assert.equal(release.prerelease, true);
  assert.deepEqual(release.assets.map((a) => a.name), ['Codemm-1.0.0-beta.1-mac-arm64.dmg', 'Codemm-1.0.0-beta.1-win-x64.exe']);
  assert.equal(release.body, undefined);
});

test('downloads need a valid, unexpired download token', async () => {
  const { body } = await subscribe('ada@example.org');
  const get = (token) => app.downloads(req('/api/downloads', { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  assert.equal((await get()).status, 401);
  assert.equal((await get('garbage')).status, 401);
  assert.equal((await get(unsubscribeTokenFor(SECRET, 1))).status, 401);
  const [payload, mac] = body.download.split('.');
  const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), exp: clock.t + 1e9 })).toString('base64url');
  assert.equal((await get(`${longer}.${mac}`)).status, 401);
  assert.equal((await get(`${payload}.${mac.slice(0, -2)}AA`)).status, 401);
  clock.t += 10 * 60 * 1000 + 1;
  assert.equal((await get(body.download)).status, 401);
});

test('tokens check purpose, expiry and signature', () => {
  const t = sign(SECRET, { p: 'dl', exp: 2000 });
  assert.deepEqual(verify(SECRET, t, 'dl', 1000), { p: 'dl', exp: 2000 });
  assert.equal(verify(SECRET, t, 'dl', 2001), null);
  assert.equal(verify(SECRET, t, 'unsub', 1000), null);
  assert.equal(verify('another-secret-of-sufficient-length-1', t, 'dl', 1000), null);
  for (const bad of [undefined, '', '.', 'a.b.c', `${t}x`, t.replace('.', '')]) assert.equal(verify(SECRET, bad, 'dl', 1000), null);
});

test('with no release yet, the form says so and downloads return none', async () => {
  app = createApp({ db, secret: SECRET, now: () => clock.t, releases: async () => [] });
  assert.equal((await (await app.form(req('/api/form'))).json()).available, false);
  const { body } = await subscribe('ada@example.org');
  const res = await app.downloads(req('/api/downloads', { headers: { authorization: `Bearer ${body.download}` } }));
  assert.deepEqual(await res.json(), { release: null });
});

/* Unsubscribe */

test('an unsubscribe token from the owner\'s email deletes the email, and tampering does nothing', async () => {
  await subscribe('ada@example.org');
  const [row] = await rows();
  const token = unsubscribeTokenFor(SECRET, Number(row.id));
  const post = (t) => app.unsubscribe(req('/api/unsubscribe', { method: 'POST', body: { token: t } }));
  assert.equal((await post(sign(SECRET, { p: 'dl', exp: clock.t + 1000 }))).status, 400);
  assert.equal((await post(unsubscribeTokenFor('wrong-secret-that-is-also-long-enough-x', Number(row.id)))).status, 400);
  assert.equal((await rows()).length, 1);
  assert.equal((await post(token)).status, 200);
  assert.equal((await rows()).length, 0);
  assert.equal((await post(token)).status, 200);
});

test('submitting someone else\'s email gives no way to remove them', async () => {
  const victim = await subscribe('victim@example.org', { ip: '192.0.2.10' });
  const attacker = await subscribe('victim@example.org', { ip: '192.0.2.11' });
  assert.equal(attacker.status, 200);
  assert.deepEqual(Object.keys(attacker.body), Object.keys(victim.body));
  assert.equal(attacker.body.unsubscribe, undefined);
  assert.equal((await rows()).length, 1);
});

test('a missing or short secret fails closed', async () => {
  const bad = createApp({ db, secret: 'short', now: () => clock.t, releases: async () => RELEASES });
  assert.equal((await bad.form(req('/api/form'))).status, 500);
});
