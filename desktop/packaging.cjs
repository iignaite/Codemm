// electron-builder settings for the macOS and Windows installers. Signing
// comes only from the environment (CI secrets or the owner's shell), never
// from this repository. Without it the build is unsigned (ad hoc on macOS).
// See SIGNING.md.

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} platform the platform being built (each runner builds its own)
 */
function packaging(env, platform = process.platform) {
  const azure = {
    endpoint: env.AZURE_SIGNING_ENDPOINT,
    codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: env.AZURE_SIGNING_PROFILE,
    publisherName: env.AZURE_SIGNING_PUBLISHER,
  };
  const winSigned = Object.values(azure).every(Boolean);
  const signed = platform === 'darwin' ? Boolean(env.CSC_LINK) : platform === 'win32' ? winSigned : false;
  return {
    appId: 'org.codemm.desktop',
    productName: 'Codemm',
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    directories: { output: 'release', buildResources: 'build' },
    // The development mock (src/main/mock.ts) and its demo course never ship (#14).
    files: ['out/**', '!out/core/**', '!out/main/mock.js', 'package.json'],
    extraResources: [
      // The core, outside the asar archive, so the agent's MCP server can run it with the app as Node (§7).
      { from: 'out/core', to: 'core' },
      // The OFL asks that the license travel with the bundled fonts.
      { from: 'src/renderer/assets/fonts', to: 'fonts', filter: ['OFL-*.txt'] },
    ],
    // Auto-update reads GitHub Releases (DESIGN §7.2): the app-update.yml in the app names this repository, and
    // the release workflow attaches the latest*.yml feeds to its draft. The build itself never publishes.
    publish: { provider: 'github', owner: 'iignaite', repo: 'Codemm' },
    // Whether this build is signed: a signed one downloads updates and offers Restart to update; an unsigned one
    // only says a new version is out, with a link to Releases.
    extraMetadata: { codemm: { signed } },
    mac: {
      // Squirrel.Mac updates from the zip; the dmg is for first installs.
      target: [
        { target: 'dmg', arch: ['arm64', 'x64'] },
        { target: 'zip', arch: ['arm64', 'x64'] },
      ],
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
      azureSignOptions: winSigned ? azure : undefined,
    },
  };
}

/**
 * Checks a release tag (`v1.2.3`, or `v1.2.3-beta.1` for a prerelease) against the
 * versions of both packages: the core (root package.json), which the app bundles,
 * and the desktop app. Only a prerelease may ship unsigned (DESIGN §7.1).
 * @param {string} tag
 * @param {{ core: string, desktop: string }} versions
 */
function releaseTag(tag, versions) {
  const m = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.exec(tag);
  if (!m) throw new Error(`"${tag}" isn't a release tag (v1.2.3, or v1.2.3-beta.1 for a prerelease).`);
  // Auto-update moves a prerelease on to the next stable release only from the alpha and beta channels (§7.2).
  if (m[2] && !/^-(alpha|beta)(\.\d+)?$/.test(m[2])) throw new Error(`"${tag}" is a prerelease, but only alpha or beta prereleases ship (v1.2.3-beta.1).`);
  const version = tag.slice(1);
  for (const [name, v] of Object.entries(versions)) {
    if (v !== version) throw new Error(`The ${name} package is ${v}, but the tag is ${tag}.`);
  }
  return { version, prerelease: Boolean(m[2]) };
}

module.exports = { packaging, releaseTag };
