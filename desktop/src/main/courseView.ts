// The course as the learner sees it (DESIGN §3.2, §4.1, §4.3), from core
// progress, the course's lessons, setup and the jobs still running.
import type { CourseView, Proposal, SetupProblem, SetupState, TopicView } from '../shared/api';
import type { CoreProgress } from './core/types';

export type Setup = { state: Exclude<SetupState, 'failed'>; proposal?: Proposal } | { state: 'failed'; problem: SetupProblem };

const trackName = (ref: string) => ref.split('@')[0];

export function courseView(
  progress: CoreProgress,
  lessons: { id: string; concept: string; title: string; read: boolean }[],
  setup: Setup,
  running: Set<string>,
): CourseView {
  const next = progress.next;
  const current = 'concept' in next ? next.concept : undefined;
  const topics = progress.concepts.map((c): TopicView => {
    const own: TopicView['lessons'] = lessons.filter((l) => l.concept === c.id).map((l) => ({ id: l.id, title: l.title, state: l.read ? 'read' : 'ready' }));
    if (running.has(`lesson:${c.id}`)) own.push({ id: `${c.id}-writing`, title: 'Lesson', state: 'writing' });
    const now = c.id === current;
    let activity: TopicView['activity'] = 'locked';
    if (c.mastered) activity = 'passed';
    else if (now && next.kind === 'practice') activity = next.lesson === undefined ? 'open' : 'locked';
    else if (now) activity = 'writing';
    return { id: c.id, title: c.title, state: c.mastered ? 'mastered' : now ? 'now' : 'later', mastery: c.mastery, stuck: c.stuck, lessons: own, activity };
  });
  return {
    goal: progress.goal,
    track: trackName(progress.track),
    setup: setup.state,
    ...(setup.state === 'failed' ? { setupProblem: setup.problem } : {}),
    ...(setup.state === 'consent' && setup.proposal ? { proposal: setup.proposal } : {}),
    topics,
    done: next.kind === 'done',
  };
}
