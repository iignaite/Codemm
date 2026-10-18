// Applies pending migrations to TURSO_DATABASE_URL (a Turso URL, or file:./data/dev.db).
// Usage: node --env-file=.env scripts/migrate.mjs (Vercel runs it in every build)
import { mkdirSync } from 'node:fs';
import { migrate, openDb } from '../lib/db.js';

// On Vercel, migrations run in the build. A build without a database (a preview) skips them.
if (!process.env.TURSO_DATABASE_URL && process.env.VERCEL) {
  console.log('No database configured; skipping migrations.');
  process.exit(0);
}

if (process.env.TURSO_DATABASE_URL?.startsWith('file:')) mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const db = openDb(process.env);
const applied = await migrate(db);
console.log(applied.length ? `Applied ${applied.join(', ')}.` : 'Already up to date.');
db.close();
