// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as entry from '../../scripts/core-entry';
import { JOB_TOOLS } from '../../../src/templates';
import { JOBS } from './agent/jobs';
import type { CoreApp } from './core/types';

// The bundled core (scripts/core-entry.ts) is what main loads in-process. It
// must have every function the desktop calls, with the shapes it expects.
const core: CoreApp = entry;

describe('the bundled core', () => {
  it('has every function the desktop calls', () => {
    const needed: (keyof CoreApp)[] = ['getRoadmap', 'listProposals', 'installProposal', 'dropProposal', 'getLesson', 'listLessons', 'listExercises', 'saveNotes', 'markLessonRead', 'readLearnerFiles', 'writeLearnerFile', 'cleanupLeftovers', 'progress', 'checkExercise'];
    for (const name of needed) expect([name, typeof core[name]]).toEqual([name, 'function']);
  });

  it('gives each job the tools core names for it', () => {
    for (const [kind, spec] of Object.entries(JOBS)) expect([kind, spec.tools]).toEqual([kind, JOB_TOOLS[kind as keyof typeof JOB_TOOLS]]);
  });
});
