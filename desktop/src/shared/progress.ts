// The stages each agent job shows while it runs (DESIGN §4.11). Each one lights up as the job reaches it.
import type { JobKind } from './api';

export const JOB_STAGES: Record<JobKind, readonly string[]> = {
  research: ['Starting', 'Researching', 'Saving the roadmap'],
  roadmap: ['Starting', 'Changing the roadmap', 'Saving the roadmap'],
  setup: ['Proposing the setup', 'Building', 'Checking the setup'],
  lesson: ['Starting', 'Writing the lesson', 'Saving the lesson'],
  author: ['Starting', 'Writing the exercise', 'Checking the exercise'],
  tutor: ['Thinking'],
  rebuild: ['Building and checking'],
};
