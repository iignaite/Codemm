// Signed tokens: base64url(JSON payload) "." base64url(HMAC-SHA256).
// Each payload names its purpose (p), so one kind can't stand in for another.
import { createHmac, timingSafeEqual } from 'node:crypto';

const mac = (secret, data) => createHmac('sha256', secret).update(data).digest();

export function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

/** The payload if the token is genuine, for this purpose, and unexpired at `now`; otherwise null. */
export function verify(secret, token, purpose, now) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1], 'base64url');
  const want = mac(secret, parts[0]);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.p !== purpose) return null;
  if (payload.exp !== undefined && !(Number.isFinite(payload.exp) && now <= payload.exp)) return null;
  return payload;
}

/** A keyed hash, for rate-limit keys that must not store an IP or an email. */
export const keyedHash = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url').slice(0, 32);
