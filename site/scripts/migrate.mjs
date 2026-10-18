// Applies pending migrations to TURSO_DATABASE_URL (a Turso URL, or file:./data/dev.db).
// Usage: node --env-file=.env scripts/migrate.mjs
import { mkdirSync } from 'node:fs';
import { migrate, openDb } from '../lib/db.js';

if (process.env.TURSO_DATABASE_URL?.startsWith('file:')) mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const db = openDb(process.env);
const applied = await migrate(db);
console.log(applied.length ? `Applied ${applied.join(', ')}.` : 'Already up to date.');
db.close();
