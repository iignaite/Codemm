import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../lib/db.js';

const flaky = (failures, code) => {
  let calls = 0;
  const run = async () => {
    calls++;
    if (calls <= failures) throw Object.assign(new Error('boom'), { code });
    return 'ok';
  };
  return { db: { execute: run, batch: run, close() {} }, calls: () => calls };
};

test('a Turso server error is retried once', async () => {
  const f = flaky(1, 'SERVER_ERROR');
  assert.equal(await withRetry(f.db, 0).execute('SELECT 1'), 'ok');
  assert.equal(f.calls(), 2);
  const g = flaky(1, 'SERVER_ERROR');
  assert.equal(await withRetry(g.db, 0).batch([], 'write'), 'ok');
});

test('a second server error, or any other error, is not retried', async () => {
  const twice = flaky(2, 'SERVER_ERROR');
  await assert.rejects(withRetry(twice.db, 0).execute('SELECT 1'), { code: 'SERVER_ERROR' });
  assert.equal(twice.calls(), 2);
  const other = flaky(1, 'SQLITE_CONSTRAINT');
  await assert.rejects(withRetry(other.db, 0).execute('SELECT 1'), { code: 'SQLITE_CONSTRAINT' });
  assert.equal(other.calls(), 1);
});
