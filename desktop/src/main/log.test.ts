// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLog } from './log';

const dir = () => mkdtempSync(join(tmpdir(), 'codemm-log-'));

describe('the app log', () => {
  it('writes one line per event, with only short, redacted values', () => {
    const d = dir();
    const log = createLog(d);
    log('job-end', { kind: 'tutor', ok: false, ms: 1200 });
    log('error', {
      message: [
        `Failed in ${join(homedir(), 'Codemm', 'exercises', 'x')}`,
        'Authorization: Bearer abc.def.ghi',
        'api_key=sk-ant-api03-SECRETSECRETSECRETSECRET',
        'token ghp_0123456789abcdefghijABCDEFGHIJ012345',
        `digest ${'a'.repeat(64)}`,
        'x'.repeat(500),
      ].join('\n'),
    });
    const text = readFileSync(join(d, 'codemm.log'), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+ job-end kind=tutor ok=false ms=1200$/);
    expect(text).not.toContain(homedir());
    expect(text).toContain('~');
    for (const secret of ['abc.def.ghi', 'SECRETSECRET', 'ghp_0123', 'a'.repeat(64)]) expect(text).not.toContain(secret);
    expect(lines[1].length).toBeLessThan(400);
  });

  it('rotates at its cap and keeps one older file', () => {
    const d = dir();
    const log = createLog(d, 1000);
    for (let i = 0; i < 100; i++) log('job-start', { kind: 'lesson', n: i });
    expect(readdirSync(d).sort()).toEqual(['codemm.1.log', 'codemm.log']);
    for (const f of readdirSync(d)) expect(readFileSync(join(d, f)).length).toBeLessThanOrEqual(1100);
  });

  it('never throws, even when it cannot write', () => {
    const log = createLog(join(dir(), 'missing', '\0bad'));
    expect(() => log('error', { message: 'x' })).not.toThrow();
  });
});
