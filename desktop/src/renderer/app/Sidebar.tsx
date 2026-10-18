// The main navigation (§1): Learn, Practice and Tracks, wide with the course or slim beside a workspace.
import type { ReactNode } from 'react';
import type { CourseView } from '../../shared/api';
import { hueColor } from '../ui/Emm';
import { Icon, type IconName } from '../ui/Icon';
import { Logo, Mark } from '../ui/Mark';
import { useApi } from './api';
import { useRouter, type Route } from './router';
import { useLoad } from './useLoad';

type Section = 'learn' | 'practice' | 'tracks';

function sectionOf(route: Route): Section {
  if (route.to === 'practice') return 'practice';
  if (route.to === 'tracks') return 'tracks';
  return 'learn';
}

function practiceRoute(course: CourseView | null | undefined): Route {
  const now = course?.topics.find((t) => t.state === 'now');
  if (!course) return { to: 'goal' };
  if (!now) return { to: 'learn' };
  return now.activity === 'open' ? { to: 'practice', concept: now.id } : { to: 'topic', topicId: now.id };
}

/** The main navigation: wide with labels, or slim with icons beside a workspace. */
export function Sidebar({ slim = false }: { slim?: boolean }) {
  const api = useApi();
  const { route, go } = useRouter();
  const { data: course } = useLoad(() => api.course(), [route]);
  const here = sectionOf(route);
  const items: { key: Section; label: string; icon: IconName; to: Route }[] = [
    { key: 'learn', label: 'Learn', icon: 'path', to: course ? { to: 'learn' } : { to: 'goal' } },
    { key: 'practice', label: 'Practice', icon: 'code', to: practiceRoute(course) },
    { key: 'tracks', label: 'Tracks', icon: 'layers', to: { to: 'tracks' } },
  ];
  const nav = items.map((item) => (
    <button
      key={item.key}
      type="button"
      className="nav"
      aria-current={here === item.key ? 'page' : undefined}
      aria-label={slim ? item.label : undefined}
      onClick={() => go(item.to)}
    >
      <Icon name={item.icon} color={here === item.key ? '#3DDB6C' : '#C9D5EA'} />
      {!slim && item.label}
    </button>
  ));
  if (slim) {
    return (
      <nav className="slim" aria-label="Main">
        <div className="lg"><Mark size={22} /></div>
        {nav}
      </nav>
    );
  }
  return (
    <nav className="side" aria-label="Main">
      <div className="logo"><Logo height={22} onNavy /></div>
      {nav}
      <div className="foot">
        {course ? (
          <div className="pick">
            <span className="badge" style={{ background: hueColor(course.track) }} aria-hidden="true">{course.goal[0]}</span>
            <span className="goal">{course.goal}</span>
          </div>
        ) : (
          <div className="pick none">No course yet</div>
        )}
      </div>
    </nav>
  );
}

/** A screen with the wide sidebar. */
export function WithSide({ children }: { children: ReactNode }) {
  return <><Sidebar />{children}</>;
}
