// The course as the learner sees it (DESIGN §3.2, §4.1, §4.3), from core
// progress, the course's lessons, setup and the jobs still running.
import type { CourseView, Proposal, SetupProblem, SetupState, TopicView } from '../shared/api';
import type { CoreProgress } from './core/types';
import { trackName } from './views';

export type Setup = { state: Exclude<SetupState, 'failed'>; proposal?: Proposal } | { state: 'failed'; problem: SetupProblem; proposal?: Proposal };

/** The topic to work on: the next step's, or while setting up, the first one whose prerequisites are mastered. */
export function currentConcept(progress: CoreProgress): string | undefined {
  const next = progress.next;
  if ('concept' in next) return next.concept;
  if (next.kind !== 'setup') return undefined;
  const mastered = new Set(progress.concepts.filter((c) => c.mastered).map((c) => c.id));
  return progress.concepts.find((c) => !c.mastered && c.requires.every((r) => mastered.has(r)))?.id;
}

/** Whether a topic besides these is ready: not mastered, with every prerequisite mastered. Only then does deferring move on (§4.4). */
export function otherReady(progress: CoreProgress, concepts: string[]): boolean {
  const complete = (c: CoreProgress['concepts'][number]) => progress.style === 'none' ? c.covered : c.mastered;
  const mastered = new Set(progress.concepts.filter(complete).map((c) => c.id));
  // A topic left for later counts as met for unlocking (core §7), so the topics after these open too.
  return progress.concepts.some((c) => !concepts.includes(c.id) && !complete(c) && c.requires.every((r) => mastered.has(r) || concepts.includes(r)));
}

export function courseView(
  progress: CoreProgress,
  lessons: { id: string; concept: string; title: string; read: boolean }[],
  setup: Setup,
  running: Set<string>,
  now = Date.now(),
  /** The concept whose lesson job failed and stalled work: its row stays, for Try again. */
  failedLesson?: string,
): Omit<CourseView, 'title'> {
  const next = progress.next;
  const activities = progress.style !== 'none';
  const current = currentConcept(progress);
  const topics = progress.concepts.map((c): TopicView => {
    const own: TopicView['lessons'] = lessons.filter((l) => l.concept === c.id).map((l) => ({ id: l.id, title: l.title, state: l.read ? 'read' : 'ready' }));
    if (running.has(`lesson:${c.id}`)) own.push({ id: `${c.id}-writing`, title: 'Lesson', state: 'writing' });
    else if (failedLesson === c.id) own.push({ id: `${c.id}-writing`, title: 'Lesson', state: 'failed' });
    const isCurrent = c.id === current;
    if (!activities) return {
      id: c.id, title: c.title, state: c.covered ? 'covered' : isCurrent ? 'now' : 'later',
      mastery: 0, stuck: false, lessons: own, activity: 'none',
    };
    let activity: TopicView['activity'] = 'locked';
    // A due review reopens a mastered topic's activity (core §7).
    const review = isCurrent && (next.kind === 'review' ? 'due' : next.kind === 'author' && next.review ? 'writing' : undefined);
    if (review === 'due') activity = 'open';
    else if (review === 'writing') activity = 'writing';
    else if (c.mastered) activity = 'passed';
    else if (isCurrent && next.kind === 'practice') activity = next.lesson === undefined ? 'open' : 'locked';
    // Stuck: the activity stays open beside the ways forward (§3.2).
    else if (isCurrent && next.kind === 'stuck') activity = 'open';
    else if (isCurrent) activity = 'writing';
    // Only future reviews count down; an overdue one waits its turn behind the review core offers now.
    const left = c.reviewDue ? Date.parse(c.reviewDue) - now : 0;
    const reviewIn = !review && left > 0 ? Math.ceil(left / 86_400_000) : undefined;
    return {
      // Before its first check a topic has only core's starting estimate, not mastery the learner showed.
      id: c.id, title: c.title, state: c.mastered ? 'mastered' : isCurrent ? 'now' : 'later', mastery: c.attempts > 0 ? c.mastery : 0, stuck: c.stuck, lessons: own, activity,
      ...(review ? { review } : {}), ...(reviewIn ? { reviewIn } : {}),
    };
  });
  return {
    goal: progress.goal,
    track: progress.track ? trackName(progress.track) : '',
    activities,
    setup: setup.state,
    ...(setup.state === 'failed' ? { setupProblem: setup.problem } : {}),
    ...(setup.proposal ? { proposal: setup.proposal } : {}),
    topics,
    done: next.kind === 'done',
  };
}
