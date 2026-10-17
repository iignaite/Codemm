import { describe, expect, it } from 'vitest';
import { packaging } from './packaging.cjs';

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
