import { describe, expect, it } from 'vitest';
import { isOfficialLink } from './links';

describe('isOfficialLink', () => {
  it('opens only https links to official install pages', () => {
    expect(isOfficialLink('https://docs.docker.com/engine/install/')).toBe(true);
    expect(isOfficialLink('http://docs.docker.com/engine/install/')).toBe(false);
    expect(isOfficialLink('https://docs.docker.com.example.com/')).toBe(false);
    expect(isOfficialLink('https://example.com/')).toBe(false);
    expect(isOfficialLink('javascript:alert(1)')).toBe(false);
    expect(isOfficialLink('file:///etc/passwd')).toBe(false);
    expect(isOfficialLink('not a url')).toBe(false);
  });
});
