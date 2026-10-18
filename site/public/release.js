// Which installer to offer: pure functions, tested in ../test/release.test.js.

// The release workflow names installers ${productName}-${version}-${os}-${arch}.${ext}
// (desktop/packaging.cjs).
const INSTALLERS = [
  { id: 'mac-arm64', os: 'mac', label: 'Download for Mac', detail: 'Apple Silicon', name: 'Mac with Apple Silicon', match: /-mac-arm64\.dmg$/i },
  { id: 'mac-x64', os: 'mac', label: 'Download for Mac', detail: 'Intel', name: 'Mac with Intel', match: /-mac-x64\.dmg$/i },
  { id: 'win-x64', os: 'windows', label: 'Download for Windows', detail: 'Windows 11, x64', name: 'Windows 11', match: /-win-x64\.exe$/i },
];

/**
 * @param {{ userAgent?: string, maxTouchPoints?: number, uaPlatform?: string, architecture?: string }} nav
 *   uaPlatform and architecture come from navigator.userAgentData where the browser has it.
 * @returns {{ os: 'mac' | 'windows' | 'other', arch: 'arm' | 'x86' | null }}
 */
export function detectPlatform({ userAgent = '', maxTouchPoints = 0, uaPlatform = '', architecture = '' } = {}) {
  const arch = architecture === 'arm' || architecture === 'x86' ? architecture : null;
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return { os: 'other', arch: null };
  if (uaPlatform === 'macOS' || /Macintosh|Mac OS X/.test(userAgent)) {
    // iPadOS Safari presents itself as a Mac.
    return maxTouchPoints > 1 ? { os: 'other', arch: null } : { os: 'mac', arch };
  }
  if (uaPlatform === 'Windows' || /Windows NT/.test(userAgent)) return { os: 'windows', arch };
  return { os: 'other', arch: null };
}

const installersIn = (release) =>
  INSTALLERS.flatMap((i) => {
    const a = (release.assets ?? []).find((x) => i.match.test(x.name));
    return a ? [{ id: i.id, os: i.os, label: i.label, detail: i.detail, name: i.name, url: a.browser_download_url }] : [];
  });

/**
 * The release to offer: the newest published stable release with installers,
 * or, until there is one, the newest beta.
 * @param {any[] | null} releases the GitHub API's list of releases
 */
export function pickRelease(releases) {
  const usable = (Array.isArray(releases) ? releases : [])
    .filter((r) => !r.draft && installersIn(r).length > 0)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return usable.find((r) => !r.prerelease) ?? usable[0] ?? null;
}

/**
 * What the download area shows for a release and a visitor's platform.
 * @param {any | null} release from pickRelease
 * @param {{ os: string, arch: string | null }} platform from detectPlatform
 */
export function downloads(release, platform) {
  if (!release) return { status: 'soon' };
  const all = installersIn(release);
  // Unknown Mac chips get Apple Silicon: every Mac sold since 2023 has it.
  const want = platform.os === 'mac' ? (platform.arch === 'x86' ? 'mac-x64' : 'mac-arm64') : platform.os === 'windows' ? 'win-x64' : null;
  const primary = all.find((i) => i.id === want) ?? null;
  const others = all.filter((i) => i !== primary).sort((a, b) => (b.os === platform.os) - (a.os === platform.os));
  return {
    status: 'ready',
    version: release.tag_name.replace(/^v/, ''),
    beta: Boolean(release.prerelease),
    url: release.html_url,
    primary,
    others,
  };
}
