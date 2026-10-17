// The only pages the app opens in the learner's browser: official install docs.
const HOSTS = new Set(['docs.docker.com']);

export function isOfficialLink(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && HOSTS.has(hostname);
  } catch {
    return false;
  }
}
