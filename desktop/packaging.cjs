// electron-builder settings. Signing comes only from the environment (CI
// secrets or the owner's shell), never from this repository; without it the
// build is unsigned. See SIGNING.md.

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
    files: ['out/**', '!out/shared/**', 'package.json'],
    // The OFL asks that the license travel with the bundled fonts.
    extraResources: [{ from: 'src/renderer/assets/fonts', to: 'fonts', filter: ['OFL-*.txt'] }],
    // Auto-update stays off until builds are signed (planned: electron-updater on GitHub Releases).
    publish: null,
    mac: {
      target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
      category: 'public.app-category.education',
      // null: never pick up a keychain identity. Notarization runs only when
      // APPLE_* credentials are in the environment.
      identity: env.CSC_LINK ? undefined : null,
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      azureSignOptions: Object.values(azure).every(Boolean) ? azure : undefined,
    },
    linux: {
      target: [
        { target: 'AppImage', arch: ['x64'] },
        { target: 'deb', arch: ['x64'] },
      ],
      category: 'Education',
      maintainer: 'Codemm contributors',
    },
  };
}

module.exports = { packaging };
