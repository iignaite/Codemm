// The main navigation (§1): Learn, Practice and Tracks, wide with the course or slim beside a workspace.
import { useSyncExternalStore, type ReactNode } from 'react';
import type { CourseView } from '../../shared/api';
import { Button } from '../ui/Button';
import { hueColor } from '../ui/Emm';
import { Icon, type IconName } from '../ui/Icon';
import { Logo, Mark } from '../ui/Mark';
import { useApi } from './api';
import { useRouter, type Route } from './router';
import { useLoad } from './useLoad';
import { continueRoute } from './course';
import { ExternalLink } from '../ui/ExternalLink';

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
  return continueRoute(now);
}

/** A narrow window, or a wide one at 200% zoom: the screen needs the sidebar's room (WCAG reflow). Matches app.css. */
const NARROW = '(max-width: 760px)';
const narrowNow = () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
function onNarrowChange(changed: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

/** The main navigation: wide with labels, or slim with icons beside a workspace or in a narrow window. */
export function Sidebar({ slim: slimHere = false }: { slim?: boolean }) {
  const slim = useSyncExternalStore(onNarrowChange, narrowNow) || slimHere;
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
        <UpdateNotice />
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

/**
 * A new version (§7.2). An unsigned build links to the release, which opens in the browser; a signed one has
 * downloaded it and offers Restart to update. Read on each screen, and every 30 s until there is something to show.
 */
function UpdateNotice() {
  const api = useApi();
  const { route, fail } = useRouter();
  // Read until there is something to say: main checks at start and every 6 hours, so news can come at any time.
  const { data: update } = useLoad(() => api.update(), [route], { settled: (u) => u.kind === 'available' || u.kind === 'ready', every: 30_000 });
  // One status region stays in place, so a screen reader hears the news when it arrives, without a focus move.
  return (
    <div role="status" aria-label="Codemm updates" className={update?.kind === 'available' || update?.kind === 'ready' ? 'update' : undefined}>
      {update?.kind === 'available' && (
        <>
          <span>A new version is available.</span>
          <ExternalLink href={update.url}>Get Codemm {update.version}</ExternalLink>
        </>
      )}
      {update?.kind === 'ready' && (
        <>
          <span>Codemm {update.version} is ready.</span>
          <Button onClick={() => void api.restartToUpdate().catch(fail)}>Restart to update</Button>
        </>
      )}
    </div>
  );
}
