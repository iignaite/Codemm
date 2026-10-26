import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packaging, releaseTag } from './packaging.cjs';

describe('packaging', () => {
  it('signs ad hoc when no signing settings are given, and says the build is unsigned', () => {
    const config = packaging({}, 'darwin');
    // Ad hoc, not none: an unsealed arm64 app is "damaged" to Gatekeeper, with no Open Anyway.
    expect(config.mac.identity).toBe('-');
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.extraMetadata).toEqual({ codemm: { signed: false } });
  });

  it('points auto-update at GitHub Releases, which the release workflow fills as a draft', () => {
    expect(packaging({}).publish).toEqual({ provider: 'github', owner: 'iignaite', repo: 'Codemm' });
    // Squirrel.Mac updates from a zip; the dmg is for first installs.
    expect(packaging({}).mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ]);
  });

  it('fails a build that should be signed but could not be, instead of shipping it unsigned', () => {
    // electron-builder otherwise only warns when it finds no signing identity.
    expect(packaging({}, 'darwin').forceCodeSigning).toBe(false);
    expect(packaging({ CSC_LINK: 'base64-p12' }, 'darwin').forceCodeSigning).toBe(true);
  });

  it('marks a build signed only by its own platform\'s signing settings', () => {
    const azure = { AZURE_SIGNING_ENDPOINT: 'https://e/', AZURE_SIGNING_ACCOUNT: 'a', AZURE_SIGNING_PROFILE: 'p', AZURE_SIGNING_PUBLISHER: 'Codemm' };
    expect(packaging({ CSC_LINK: 'base64-p12' }, 'darwin').extraMetadata).toEqual({ codemm: { signed: true } });
    expect(packaging(azure, 'darwin').extraMetadata).toEqual({ codemm: { signed: false } });
    expect(packaging(azure, 'win32').extraMetadata).toEqual({ codemm: { signed: true } });
    expect(packaging({ CSC_LINK: 'base64-p12' }, 'win32').extraMetadata).toEqual({ codemm: { signed: false } });
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

  it('leaves the development mock and its demo curriculum out of the installer', () => {
    expect(packaging({}).files).toContain('!out/main/mock.js');
  });

  it('carries the licenses of the fonts and of everything the renderer bundles, outside the archive', () => {
    const from = (packaging({}).extraResources as { from: string }[]).map((r) => r.from);
    expect(from).toContain('src/renderer/assets/fonts');
    // vite.config.mts writes them to out/renderer/licenses.md (build.license).
    expect(from).toContain('out/renderer/licenses.md');
  });

  it('ships each installer only its own chip\'s wasmtime, with its license, outside the archive', () => {
    // scripts/fetch-wasmtime.mjs fills vendor/wasmtime/<os>-<arch>; electron-builder expands the macros per build.
    expect(packaging({}).extraResources).toContainEqual({ from: 'vendor/wasmtime/${os}-${arch}', to: 'wasmtime' });
  });

  it('signs the binaries beside the app, wasmtime among them, with the entitlement wasmtime needs to run compiled code', () => {
    // Under the hardened runtime, wasmtime maps the code it compiled, or precompiled, as executable: without
    // allow-unsigned-executable-memory, macOS kills it (exit 137) or refuses the mapping. allow-jit alone isn't enough,
    // since wasmtime doesn't use MAP_JIT. Checked with wasmtime 50 on macOS 15. electron-builder reads this file from
    // build/ for every binary but the app itself, so nothing may override it.
    expect(packaging({ CSC_LINK: 'base64-p12' }, 'darwin').mac).not.toHaveProperty('entitlementsInherit');
    const inherit = readFileSync(join(__dirname, 'build', 'entitlements.mac.inherit.plist'), 'utf8');
    expect(inherit).toMatch(/<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\/>/);
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

  it('takes only alpha and beta prereleases, the channels auto-update moves on to a stable release from', () => {
    expect(releaseTag('v1.0.0-alpha.2', both('1.0.0-alpha.2'))).toEqual({ version: '1.0.0-alpha.2', prerelease: true });
    for (const tag of ['v1.0.0-rc.1', 'v1.0.0-preview', 'v1.0.0-next.1']) expect(() => releaseTag(tag, both(tag.slice(1)))).toThrow(/alpha or beta/);
  });

  it('refuses anything that is not a version tag', () => {
    for (const tag of ['1.0.0', 'v1.0', 'v1.0.0+build', 'vnext', 'v1.0.0-']) expect(() => releaseTag(tag, both(tag.slice(1)))).toThrow(/isn't a release tag/);
  });
});
