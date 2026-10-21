// The learner's courses at the sidebar's foot (§4.13): the one on screen is marked, choosing another puts it on screen,
// and New course opens the goal screen. In the slim sidebar each course is its badge, named by its title.
import type { CourseSummary } from '../../shared/api';
import { hueColor } from '../ui/Emm';
import { Icon } from '../ui/Icon';
import { useApi } from './api';
import { cacheFor, lessonCache } from './cache';
import { useRouter } from './router';
import { useLoad } from './useLoad';

/** A badge's character: the title's first one as the eye sees it (a flag or a joined emoji whole), capitalized when that stays one letter ("ß" doesn't). */
function initialOf(title: string): string {
  const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title);
  const char = first?.segment ?? '';
  const upper = char.toUpperCase();
  return upper.length === char.length ? upper : char;
}

export function Courses({ slim = false }: { slim?: boolean }) {
  const api = useApi();
  const { route, go, fail } = useRouter();
  const { data: courses } = useLoad(() => api.courses(), [route]);
  if (!courses) return null;
  // The first course's research or roadmap is on screen: it isn't a course yet, but "No course yet" would deny it.
  const drafting = route.to === 'research' || route.to === 'course';
  if (courses.length === 0 && (slim || !drafting)) return slim ? null : <div className="pick none">No course yet</div>;

  async function open(course: CourseSummary) {
    try {
      if (!course.current) {
        await api.switchCourse(course.id);
        // What this window cached belongs to the course that was on screen: lesson ids repeat across courses.
        lessonCache(api).clear();
        cacheFor(api, 'conversations').clear();
      }
      go({ to: 'learn', course: course.id });
    } catch (e) {
      fail(e);
    }
  }

  // Two courses researched with the same words are told apart by their goals.
  const name = (c: CourseSummary) => (courses.some((o) => o !== c && o.title === c.title) ? c.goal : c.title);
  const badge = (c: CourseSummary) => <span className="badge" style={{ background: hueColor(c.track) }} aria-hidden="true">{initialOf(c.title)}</span>;
  return (
    <div className={slim ? 'courses slim-courses' : 'courses'}>
      {courses.map((c) => (
        <button key={c.id} type="button" className={slim ? 'nav' : 'pick'} aria-current={c.current ? 'true' : undefined} aria-label={slim ? name(c) : undefined} onClick={() => void open(c)}>
          {badge(c)}
          {!slim && <span className="goal">{name(c)}</span>}
        </button>
      ))}
      <button type="button" className="nav" aria-label={slim ? 'New course' : undefined} onClick={() => go({ to: 'goal' })}>
        <Icon name="plus" color="#C9D5EA" size={slim ? 18 : 16} />
        {!slim && 'New course'}
      </button>
    </div>
  );
}
