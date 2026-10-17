// Links open in the learner's browser only after a click, and only for https
// URLs (DESIGN §2.1).
export function isSafeLink(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
