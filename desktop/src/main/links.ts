// The only pages the app opens in the learner's browser: official install
// docs for Docker and for each agent.
const HOSTS = new Set(['docs.docker.com', 'code.claude.com', 'developers.openai.com', 'cursor.com']);

export function isOfficialLink(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && HOSTS.has(hostname);
  } catch {
    return false;
  }
}
