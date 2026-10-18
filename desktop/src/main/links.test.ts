import { describe, expect, it } from 'vitest';
import { isSafeLink, openOutside } from './links';

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

describe('openOutside', () => {
  it('opens an https link in the system browser and never in a new app window', () => {
    const opened: string[] = [];
    const handler = openOutside((url) => opened.push(url));
    expect(handler({ url: 'https://react.dev/learn' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'http://example.com' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(opened).toEqual(['https://react.dev/learn']);
  });
});
