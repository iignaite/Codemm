import { describe, expect, it } from 'vitest';
import { isSafeLink } from './links';

describe('isSafeLink', () => {
  it('opens only https links', () => {
    expect(isSafeLink('https://docs.docker.com/engine/install/')).toBe(true);
    expect(isSafeLink('https://example.com/a?b')).toBe(true);
    expect(isSafeLink('http://docs.docker.com/')).toBe(false);
    expect(isSafeLink('javascript:alert(1)')).toBe(false);
    expect(isSafeLink('file:///etc/passwd')).toBe(false);
    expect(isSafeLink('not a url')).toBe(false);
  });
});
