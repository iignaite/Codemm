// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as entry from '../../scripts/core-entry';
import type { CoreApp } from './core/types';

// The bundled core (scripts/core-entry.ts) is what main loads in-process. It
// must have every function the desktop calls, with the shapes it expects.
const core: CoreApp = entry;

describe('the bundled core', () => {
  it('has every function the desktop calls', () => {
    const needed: (keyof CoreApp)[] = ['getRoadmap', 'listProposals', 'installProposal', 'dropProposal', 'getLesson', 'listLessons', 'listExercises', 'saveNotes', 'markLessonRead', 'readLearnerFiles', 'writeLearnerFile', 'cleanupLeftovers', 'progress', 'checkExercise', 'hiddenMaterial', 'runtimeState', 'networkIsolation'];
    for (const name of needed) expect([name, typeof core[name]]).toEqual([name, 'function']);
  });
});
