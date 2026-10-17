import { describe, expect, it } from 'vitest';
import { packaging, releaseTag } from './packaging.cjs';

describe('packaging', () => {
  it('signs ad hoc, with no auto-update, when no signing settings are given', () => {
    const config = packaging({});
    // Ad hoc, not none: an unsealed arm64 app is "damaged" to Gatekeeper, with no Open Anyway.
    expect(config.mac.identity).toBe('-');
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.publish).toBeNull();
  });

  it('signs on macOS only from a certificate in the environment', () => {
    expect(packaging({ CSC_LINK: '' }).mac.identity).toBe('-');
    expect(packaging({ CSC_LINK: 'base64-p12' }).mac.identity).toBeUndefined();
  });

  it('uses the hardened runtime only with a real certificate', () => {
    // Ad hoc signing plus the hardened runtime fails library validation at launch.
    expect(packaging({}).mac.hardenedRuntime).toBe(false);
    expect(packaging({ CSC_LINK: 'base64-p12' }).mac.hardenedRuntime).toBe(true);
  });

  it('builds only macOS and Windows installers', () => {
    const config = packaging({}) as Record<string, unknown>;
    expect(config.linux).toBeUndefined();
  });

  it('signs on Windows with Azure Trusted Signing when its settings are all present', () => {
    const env = {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT: 'codemm',
      AZURE_SIGNING_PROFILE: 'public',
      AZURE_SIGNING_PUBLISHER: 'Codemm',
    };
    expect(packaging(env).win.azureSignOptions).toEqual({
      endpoint: env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: 'codemm',
      certificateProfileName: 'public',
      publisherName: 'Codemm',
    });
    expect(packaging({ ...env, AZURE_SIGNING_PROFILE: '' }).win.azureSignOptions).toBeUndefined();
  });
});

describe('releaseTag', () => {
  const both = (v: string) => ({ core: v, desktop: v });

  it('accepts a stable tag whose version both packages carry, and requires signing for it', () => {
    expect(releaseTag('v1.0.0', both('1.0.0'))).toEqual({ version: '1.0.0', prerelease: false });
  });

  it('marks a tag with a prerelease suffix as a prerelease, which may ship unsigned', () => {
    expect(releaseTag('v1.0.0-beta.1', both('1.0.0-beta.1'))).toEqual({ version: '1.0.0-beta.1', prerelease: true });
  });

  it('refuses a tag when either package carries another version', () => {
    expect(() => releaseTag('v1.0.0-beta.1', both('1.0.0'))).toThrow('The core package is 1.0.0, but the tag is v1.0.0-beta.1.');
    expect(() => releaseTag('v1.0.0', { core: '1.0.0', desktop: '0.9.0' })).toThrow('The desktop package is 0.9.0, but the tag is v1.0.0.');
  });

  it('refuses anything that is not a version tag', () => {
    for (const tag of ['1.0.0', 'v1.0', 'v1.0.0+build', 'vnext', 'v1.0.0-']) expect(() => releaseTag(tag, both(tag.slice(1)))).toThrow(/isn't a release tag/);
  });
});
