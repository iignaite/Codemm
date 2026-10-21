/**
 * The learner's typed goal as shown while research runs, before the agent's title exists: spaces tidied, a trailing
 * "?" or "!" dropped and the first letter capitalized, unless the second already is ("iOS", "jQuery"). Only
 * punctuation and that one letter are touched, so "C++" stays.
 */
export function shownTopic(typed: string): string {
  const tidy = typed.trim().replace(/\s+/g, ' ');
  const [first = '', second = '', ...rest] = tidy.replace(/[?!]+$/, '').trimEnd();
  if (!first) return tidy;
  const keep = second !== second.toLowerCase();
  return (keep ? first : first.toUpperCase()) + second + rest.join('');
}
