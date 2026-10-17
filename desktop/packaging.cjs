// electron-builder settings for the macOS and Windows installers. Signing
// comes only from the environment (CI secrets or the owner's shell), never
// from this repository. Without it the build is unsigned (ad hoc on macOS).
// See SIGNING.md.

/** @param {Record<string, string | undefined>} env */
function packaging(env) {
  const azure = {
    endpoint: env.AZURE_SIGNING_ENDPOINT,
    codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: env.AZURE_SIGNING_PROFILE,
    publisherName: env.AZURE_SIGNING_PUBLISHER,
  };
  return {
    appId: 'org.codemm.desktop',
    productName: 'Codemm',
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    directories: { output: 'release', buildResources: 'build' },
    files: ['out/**', '!out/core/**', 'package.json'],
    extraResources: [
      // The core, outside the asar archive, so the agent's MCP server can run it with the app as Node (§7).
      { from: 'out/core', to: 'core' },
      // The OFL asks that the license travel with the bundled fonts.
      { from: 'src/renderer/assets/fonts', to: 'fonts', filter: ['OFL-*.txt'] },
    ],
    // Auto-update stays off until builds are signed (planned: electron-updater on GitHub Releases).
    publish: null,
    mac: {
      target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
      category: 'public.app-category.education',
      // Without a certificate, sign ad hoc ('-'), never from the keychain. An
      // unsealed arm64 app is "damaged" to Gatekeeper and can't be opened at
      // all; an ad hoc one gets Open Anyway. Notarization runs only when
      // APPLE_* credentials are in the environment.
      identity: env.CSC_LINK ? undefined : '-',
      // Notarization needs the hardened runtime; ad hoc signing with it fails
      // library validation at launch, so it's on only with a real certificate.
      hardenedRuntime: Boolean(env.CSC_LINK),
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      azureSignOptions: Object.values(azure).every(Boolean) ? azure : undefined,
    },
  };
}

module.exports = { packaging };
