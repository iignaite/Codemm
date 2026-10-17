// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { complete, MISSING, withAdapters } from './adapters';

describe('core adapters', () => {
  it('fills each missing core function with one that says what it needs', () => {
    const core = withAdapters({ listTracks: () => [] });
    expect(core.listTracks()).toEqual([]);
    expect(() => core.getLesson('/ws', 'l1')).toThrow(MISSING);
    expect(complete({ listTracks: () => [] })).toBe(false);
  });
});
