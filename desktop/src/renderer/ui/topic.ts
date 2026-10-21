/**
 * The learner's typed goal as shown while research runs, before the agent's title exists: spaces tidied, a trailing
 * "?" or "!" dropped and the first letter capitalized. Only punctuation is touched, never a name, so "C++" stays.
 */
export function shownTopic(typed: string): string {
  const tidy = typed.trim().replace(/\s+/g, ' ');
  const [first = '', ...rest] = tidy.replace(/[?!]+$/, '').trimEnd();
  return first ? first.toUpperCase() + rest.join('') : tidy;
}
