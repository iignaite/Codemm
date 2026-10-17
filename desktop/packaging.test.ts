import { describe, expect, it } from 'vitest';
import { packaging } from './packaging.cjs';

describe('packaging', () => {
  it('builds unsigned, with no auto-update, when no signing settings are given', () => {
    const config = packaging({});
    expect(config.mac.identity).toBeNull();
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.publish).toBeNull();
  });

  it('signs on macOS only from a certificate in the environment', () => {
    expect(packaging({ CSC_LINK: '' }).mac.identity).toBeNull();
    expect(packaging({ CSC_LINK: 'base64-p12' }).mac.identity).toBeUndefined();
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
