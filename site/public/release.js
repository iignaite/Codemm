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
 * What the download area shows: two buttons, Mac and Windows, the visitor's own
 * first and highlighted. The Mac button is the build for the visitor's chip; when
 * the browser doesn't report it (Safari, Firefox), it's Apple Silicon, with a link
 * to the Intel build so Intel Macs aren't handed one that won't run.
 * @param {any | null} release from pickRelease
 * @param {{ os: string, arch: string | null }} platform from detectPlatform
 */
export function downloads(release, platform) {
  if (!release) return { status: 'soon' };
  const all = installersIn(release);
  const find = (id) => all.find((i) => i.id === id) ?? null;
  const arm = find('mac-arm64');
  const intel = find('mac-x64');
  // Only a Mac's own chip says which Mac build it needs.
  const chip = platform.os === 'mac' ? platform.arch : null;
  const mac = chip === 'x86' ? intel ?? arm : arm ?? intel;
  const win = find('win-x64');
  const buttons = [
    mac && { os: 'mac', label: 'Download for Mac', url: mac.url },
    win && { os: 'windows', label: 'Download for Windows', url: win.url },
  ].filter(Boolean);
  if (platform.os === 'windows') buttons.reverse();
  for (const b of buttons) b.primary = b.os === platform.os;
  return {
    status: 'ready',
    // Prereleases are unsigned builds: the page shows the one-time first-launch step.
    unsigned: Boolean(release.prerelease),
    buttons,
    intel: mac === arm && intel && chip !== 'arm' ? intel.url : null,
  };
}
