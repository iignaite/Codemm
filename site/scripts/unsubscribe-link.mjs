// Exports each consenting subscriber's email and unsubscribe link, for the owner's
// release emails, to a private file (owner-only permissions). Prints only a count.
// Usage: node --env-file=.env.turso scripts/unsubscribe-link.mjs https://your-domain subscribers.tsv
// The file holds email addresses: keep it out of the repository and delete it after use.
import { writeFileSync } from 'node:fs';
import { openDb } from '../lib/db.js';
import { unsubscribeTokenFor } from '../lib/app.js';

const [site, out] = [process.argv[2]?.replace(/\/$/, ''), process.argv[3]];
if (!site || !out || !process.env.SITE_SECRET) {
  throw new Error('Usage: node --env-file=.env.turso scripts/unsubscribe-link.mjs https://your-domain <output file> (SITE_SECRET set)');
}
const db = openDb(process.env);
const { rows } = await db.execute('SELECT id, email FROM subscribers WHERE consent = 1 ORDER BY id');
db.close();
const lines = rows.map((r) => `${r.email}\t${site}/unsubscribe#${new URLSearchParams({ u: unsubscribeTokenFor(process.env.SITE_SECRET, Number(r.id)) })}`);
writeFileSync(out, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600, flag: 'wx' });
console.log(`Wrote ${rows.length} subscribers to ${out}.`);
