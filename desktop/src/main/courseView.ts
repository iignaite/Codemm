// The course as the learner sees it (DESIGN §3.2, §4.1, §4.3), from core
// progress, the course's lessons, setup and the jobs still running.
import type { CourseView, Proposal, SetupProblem, SetupState, TopicView } from '../shared/api';
import type { CoreProgress } from './core/types';

export type Setup = { state: Exclude<SetupState, 'failed'>; proposal?: Proposal } | { state: 'failed'; problem: SetupProblem; proposal?: Proposal };

/** The topic to work on: the next step's, or while setting up, the first one whose prerequisites are mastered. */
export function currentConcept(progress: CoreProgress): string | undefined {
  const next = progress.next;
  if ('concept' in next) return next.concept;
  if (next.kind !== 'setup') return undefined;
  const mastered = new Set(progress.concepts.filter((c) => c.mastered).map((c) => c.id));
  return progress.concepts.find((c) => !c.mastered && c.requires.every((r) => mastered.has(r)))?.id;
}

const trackName = (ref: string) => ref.split('@')[0];

export function courseView(
  progress: CoreProgress,
  lessons: { id: string; concept: string; title: string; read: boolean }[],
  setup: Setup,
  running: Set<string>,
): CourseView {
  const next = progress.next;
  const current = currentConcept(progress);
  const topics = progress.concepts.map((c): TopicView => {
    const own: TopicView['lessons'] = lessons.filter((l) => l.concept === c.id).map((l) => ({ id: l.id, title: l.title, state: l.read ? 'read' : 'ready' }));
    if (running.has(`lesson:${c.id}`)) own.push({ id: `${c.id}-writing`, title: 'Lesson', state: 'writing' });
    const now = c.id === current;
    let activity: TopicView['activity'] = 'locked';
    if (c.mastered) activity = 'passed';
    else if (now && next.kind === 'practice') activity = next.lesson === undefined ? 'open' : 'locked';
    // Stuck: the activity stays open beside the ways forward (§3.2).
    else if (now && next.kind === 'stuck') activity = 'open';
    else if (now) activity = 'writing';
    return { id: c.id, title: c.title, state: c.mastered ? 'mastered' : now ? 'now' : 'later', mastery: c.mastery, stuck: c.stuck, lessons: own, activity };
  });
  return {
    goal: progress.goal,
    track: trackName(progress.track),
    setup: setup.state,
    ...(setup.state === 'failed' ? { setupProblem: setup.problem } : {}),
    ...(setup.proposal ? { proposal: setup.proposal } : {}),
    topics,
    done: next.kind === 'done',
  };
}
