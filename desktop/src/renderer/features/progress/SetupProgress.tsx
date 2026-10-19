import type { CourseView } from '../../../shared/api';
import { useJob } from '../../app/useJob';
import { Busy } from '../../ui/Busy';
import { JobBar } from '../../ui/JobBar';

const BUSY = { proposing: 'Preparing setup for', installing: 'Setting up' } as const;

/**
 * Setup's progress on the course map while the track sets up, as on the topic page (§4.11): the agent proposing, then
 * Codemm building and checking. A proposing agent may still be ending its turn while the install runs, so each state
 * follows its own job. Nothing once setup waits for consent, is ready or failed: the topic page handles those.
 */
export function SetupProgress({ course }: { course: CourseView }) {
  const installing = course.setup === 'installing';
  const job = useJob((p) => p.kind === 'setup' && (installing ? p.stage > 0 : p.stage === 0), [installing]);
  if (course.setup !== 'proposing' && course.setup !== 'installing') return null;
  if (!job) return <Busy className="a-up">{BUSY[course.setup]} {course.track}</Busy>;
  return (
    <section className="card setup-progress a-up" aria-labelledby="map-setup-t">
      <h2 className="h3" id="map-setup-t">Setting up {course.track}</h2>
      <JobBar job={job} label={`Setting up ${course.track}`} />
    </section>
  );
}
