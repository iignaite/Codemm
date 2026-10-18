// The libSQL client and schema migrations. Turso in production; a local SQLite
// file (file:./data/dev.db) in development.
import { readdirSync, readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

export function openDb(env) {
  if (!env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not set');
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}

const MIGRATIONS = new URL('../migrations/', import.meta.url);

const statements = (sql) =>
  sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);

/** Applies each migrations/*.sql not yet applied, in name order, each in one transaction. Returns the names applied. */
export async function migrate(db, now = Date.now()) {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set((await db.execute('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(new URL(name, MIGRATIONS), 'utf8');
    await db.batch([...statements(sql), { sql: 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', args: [name, now] }], 'write');
    applied.push(name);
  }
  return applied;
}
