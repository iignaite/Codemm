// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { REBUILD } from '../shared/api';
import { asNotCounted, notCounted } from './notCounted';
import { coreError } from './testing/fakes';

describe('not counted (§5)', () => {
  it('names this computer\'s problem, or a rebuild, and nothing for any other error', () => {
    expect(notCounted(coreError('x', 'docker'))).toBe("Docker isn't running.");
    expect(notCounted(coreError('x', 'disk'))).toBe('Docker ran out of disk space.');
    expect(notCounted(coreError('x', 'offline'))).toBe("Docker couldn't reach the network.");
    expect(notCounted(coreError('x', 'image-missing'))).toBe(REBUILD);
    expect(notCounted(Object.assign(new Error('full'), { code: 'ENOSPC' }))).toBe('Docker ran out of disk space.');
    expect(notCounted(coreError('x', 'damaged'))).toBeNull();
    expect(notCounted(new Error("The container runtime isn't running."))).toBeNull();
  });

  it('says it was not counted and logs which run, or rethrows anything else as it was', () => {
    const logged: unknown[] = [];
    const log = (event: string, fields?: unknown) => void logged.push([event, fields]);
    expect(asNotCounted(coreError('x', 'docker'), log, 'check', 'not-counted')).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
    expect(asNotCounted(coreError('x', 'disk'), log, 'example', 'not-run')).toEqual({ kind: 'not-run', reason: 'Docker ran out of disk space.' });
    expect(logged).toEqual([['not-counted', { run: 'check', reason: "Docker isn't running." }], ['not-counted', { run: 'example', reason: 'Docker ran out of disk space.' }]]);
    const other = new Error('boom');
    expect(() => asNotCounted(other, log, 'try', 'not-counted')).toThrow(other);
    expect(logged).toHaveLength(2);
  });
});
