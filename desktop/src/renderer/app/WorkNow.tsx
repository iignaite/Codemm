// Codemm's long jobs, from every screen (§4.11): what each one is and its stage, under the main navigation. A screen
// that shows a job's own bar owns it (ui/shownJobs.ts), so the sidebar shows only the others.
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CodemmApi, CourseView, Goal, JobProgress } from '../../shared/api';
import { JOB_STAGES } from '../../shared/progress';
import { EmmFill } from '../ui/EmmFill';
import { fillOf, QUIET_MS, useNow } from '../ui/JobBar';
import { useShownJobs } from '../ui/shownJobs';
import { useApi } from './api';
import { useRouter, type Route } from './router';
import { useJobs, type HeardJob } from './useJob';

type Course = CourseView | null | undefined;

/** The goal research last ran for: a report doesn't carry it, and the research screen needs it to open. */
let researching: Goal | undefined;

/** What the job is, in a few words. */
function whatOf(p: JobProgress, course: Course): string {
  const topic = course?.topics.find((t) => t.id === p.concept)?.title;
  switch (p.kind) {
    case 'research':
      return researching ? `Researching ${researching.topic}` : 'Researching';
    case 'roadmap':
      return 'Changing the roadmap';
    case 'setup':
      return course ? `Setting up ${course.track}` : 'Setting up';
    case 'rebuild':
      return p.track ? `Rebuilding ${p.track}` : 'Rebuilding';
    case 'lesson':
      return topic ? `Writing a lesson on ${topic}` : 'Writing a lesson';
    default:
      return topic ? `Writing an activity on ${topic}` : 'Writing an activity';
  }
}

/** Where it is: a retry, a quiet job, or its stage with the real fraction when there is one. */
function stageOf(p: JobProgress, quiet: boolean): string {
  if (p.retry) return `Try ${p.retry.attempt} of ${p.retry.of}`;
  if (quiet) return 'Still working';
  const stages = JOB_STAGES[p.kind];
  const stage = stages[Math.min(p.stage, stages.length - 1)];
  return p.part && p.part.total > 0 ? `${stage}, step ${p.part.done} of ${p.part.total}` : stage;
}

/** The place a job belongs to. */
async function placeOf(p: JobProgress, course: Course, api: CodemmApi): Promise<Route> {
  switch (p.kind) {
    case 'research':
      return researching ? { to: 'research', goal: researching } : { to: 'goal' };
    case 'roadmap': {
      const draft = await api.draft();
      return draft ? { to: 'course', roadmap: draft } : { to: 'learn' };
    }
    case 'setup': {
      const now = course?.topics.find((t) => t.state === 'now');
      return now ? { to: 'topic', topicId: now.id } : { to: 'learn' };
    }
    case 'rebuild':
      return { to: 'tracks' };
    default:
      return p.concept ? { to: 'topic', topicId: p.concept } : { to: 'learn' };
  }
}

/**
 * The jobs to list: one job per kind and topic or track, the furthest along (a proposing agent can end its turn while
 * the install runs), and none of a group a screen shows a bar for, nor a tutor turn (its answer is on its own screen).
 */
function listed(jobs: HeardJob[], shown: ReadonlySet<string>): HeardJob[] {
  const groups = new Map<string, { best: HeardJob; shown: boolean }>();
  for (const job of jobs) {
    const { kind, job: id, concept, track, stage } = job.progress;
    if (kind === 'tutor') continue;
    const key = `${kind}:${concept ?? track ?? ''}`;
    const group = groups.get(key);
    const best = !group || stage >= group.best.progress.stage ? job : group.best;
    groups.set(key, { best, shown: shown.has(id) || Boolean(group?.shown) });
  }
  return [...groups.values()].filter((g) => !g.shown).map((g) => g.best);
}

/** The running jobs that no screen shows. Wide: Emm filling, what it is and its stage. Slim: Emm alone, named for screen readers. */
export function WorkNow({ course, slim = false }: { course: Course; slim?: boolean }) {
  const { route } = useRouter();
  useEffect(() => {
    if (route.to === 'research') researching = route.goal;
  }, [route]);
  const jobs = listed(useJobs(() => true, []), useShownJobs());
  if (jobs.length === 0) return null;
  return (
    <ul className="work" aria-label="Codemm is working">
      {jobs.map((job) => (
        <li key={job.progress.job}>
          <WorkJob job={job} course={course} slim={slim} />
        </li>
      ))}
    </ul>
  );
}

function WorkJob({ job, course, slim }: { job: HeardJob; course: Course; slim: boolean }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const now = useNow();
  const p = job.progress;
  const quiet = p.thinking && p.idleMs + Math.max(0, now - job.at) >= QUIET_MS;
  const what = whatOf(p, course);
  const stage = stageOf(p, quiet);
  const label = `${what}, ${stage}`;
  const open = () => placeOf(p, course, api).then(go, fail);
  // A job that ends under the keyboard's focus hands it to the navigation, not to nowhere.
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(
    () => () => {
      if (button.current && button.current === document.activeElement) {
        const nav = button.current.closest('nav');
        (nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>('.nav'))?.focus();
      }
    },
    [],
  );
  return (
    <button ref={button} type="button" className="work-job" aria-label={label} title={slim ? label : undefined} onClick={() => void open()}>
      <EmmFill value={fillOf(p)} width={slim ? 32 : 28} dim={Boolean(p.retry) || quiet} />
      {!slim && (
        <span className="work-text">
          <span className="work-what">{what}</span>
          <span className="work-stage">{stage}</span>
        </span>
      )}
    </button>
  );
}
