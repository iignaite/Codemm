// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { REBUILD } from '../shared/api';
import { asNotCounted, notCounted } from './notCounted';
import { coreError } from './testing/fakes';

describe('not counted (§5)', () => {
  it('names this computer\'s problem, or a rebuild, and nothing for any other error', () => {
    expect(notCounted(coreError('x', 'docker'))).toBe("Docker isn't running.");
    expect(notCounted(coreError('x', 'disk'))).toBe('This computer is out of disk space.');
    expect(notCounted(coreError('x', 'disk', 'docker-disk'))).toBe('Docker ran out of disk space.');
    expect(notCounted(coreError('x', 'offline'))).toBe("Docker couldn't reach the network.");
    // Docker that is up, but slow or failing, isn't called stopped.
    expect(notCounted(coreError('x', 'docker', 'check-timeout'))).toBe('Docker is busy or not answering.');
    expect(notCounted(coreError('x', 'docker', 'container-start'))).toBe("Docker couldn't run that.");
    // A reason core named says what to change.
    expect(notCounted(coreError('x', 'docker', 'docker-cpus'))).toMatch(/^Docker has fewer than the 2 CPUs a check uses\. Give it more/);
    expect(notCounted(coreError('x', 'image-missing'))).toBe(REBUILD);
    expect(notCounted(Object.assign(new Error('full'), { code: 'ENOSPC' }))).toBe('This computer is out of disk space.');
    expect(notCounted(coreError('x', 'damaged'))).toBeNull();
    expect(notCounted(new Error("The container runtime isn't running."))).toBeNull();
  });

  it('says it was not counted and logs which run, or rethrows anything else as it was', () => {
    const logged: unknown[] = [];
    const log = (event: string, fields?: unknown) => void logged.push([event, fields]);
    expect(asNotCounted(coreError('x', 'docker'), log, 'check', 'not-counted')).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
    expect(asNotCounted(coreError('x', 'disk', 'docker-disk'), log, 'example', 'not-run')).toEqual({ kind: 'not-run', reason: 'Docker ran out of disk space.' });
    expect(asNotCounted(coreError("The container runtime isn't answering.", 'docker', 'runtime-busy'), log, 'try', 'not-counted')).toEqual({ kind: 'not-counted', reason: 'Docker is busy or not answering.' });
    // Which failure it was goes to the log as a fixed label, never core's text.
    expect(logged).toEqual([
      ['not-counted', { run: 'check', reason: "Docker isn't running.", cause: 'other' }],
      ['not-counted', { run: 'example', reason: 'Docker ran out of disk space.', cause: 'docker-disk' }],
      ['not-counted', { run: 'try', reason: 'Docker is busy or not answering.', cause: 'runtime-busy' }],
    ]);
    const other = new Error('boom');
    expect(() => asNotCounted(other, log, 'try', 'not-counted')).toThrow(other);
    expect(logged).toHaveLength(3);
  });
});
