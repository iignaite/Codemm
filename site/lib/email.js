// Server-side email validation. ASCII only, deliberately stricter than RFC 5321:
// a dot-atom local part and a hostname with a letter TLD.
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

/** The normalized email (trimmed, lowercased), or null if it isn't a valid address. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string' || raw.length > 320) return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split('.');
  if (local.length > 64 || !LOCAL.test(local)) return null;
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1))) return null;
  return email;
}
