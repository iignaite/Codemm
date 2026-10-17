// The core functions the desktop needs that the bundled core doesn't have yet.
// ADAPTER: they arrive with the core desktop additions (PR #23). Until then a
// call says so, instead of guessing at behavior.
import type { CoreApp } from './types';

const ADDITIONS = [
  'getRoadmap',
  'listProposals',
  'installProposal',
  'dropProposal',
  'getLesson',
  'listLessons',
  'saveNotes',
  'markLessonRead',
  'readLearnerFiles',
  'writeLearnerFile',
] as const;

export const MISSING = 'This needs the core desktop additions (PR #23).';

export function withAdapters(raw: Partial<CoreApp>): CoreApp {
  const filled: Record<string, unknown> = { ...raw };
  for (const name of ADDITIONS) {
    if (typeof filled[name] !== 'function') {
      filled[name] = () => {
        throw new Error(`${MISSING} (${name})`);
      };
    }
  }
  return filled as unknown as CoreApp;
}

/** Whether this core has every function the desktop needs. */
export const complete = (raw: Partial<CoreApp>) => ADDITIONS.every((name) => typeof raw[name] === 'function');
