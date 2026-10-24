// The main navigation (§1): Learn, Practice, Tracks and Agent, wide with the course or slim beside a workspace.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { CourseView } from '../../shared/api';
import { Button } from '../ui/Button';
import { Emm } from '../ui/Emm';
import { Icon, type IconName } from '../ui/Icon';
import { Logo } from '../ui/Mark';
import { useApi } from './api';
import { useRouter, type Route } from './router';
import { useLoad } from './useLoad';
import { offeredTopic } from './course';
import { Courses } from './Courses';
import { ExternalLink } from '../ui/ExternalLink';
import { editorRoute, WorkNow } from './WorkNow';

type Section = 'learn' | 'practice' | 'tracks';

function sectionOf(route: Route): Section {
  if (route.to === 'practice') return 'practice';
  if (route.to === 'tracks') return 'tracks';
  return 'learn';
}

/** Practice is the activity of the topic Codemm offers now. Its screen says when that waits for the lessons or isn't ready. */
function practiceRoute(course: CourseView | null | undefined): Route {
  if (!course) return { to: 'goal' };
  const offered = offeredTopic(course.topics);
  return offered ? { to: 'practice', concept: offered.id } : { to: 'learn' };
}

/** Where the learner is already: going there again would only reset the screen (its results, a running program). */
const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

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
  const { route, go, fail } = useRouter();
  const { data: course } = useLoad(() => api.course(), [route]);
  const here = sectionOf(route);
  const items: { key: Section | 'agent'; label: string; icon: IconName; to: Route | (() => Promise<Route>) }[] = [
    { key: 'learn', label: 'Learn', icon: 'path', to: course ? { to: 'learn' } : { to: 'goal' } },
    { key: 'practice', label: 'Practice', icon: 'code', to: practiceRoute(course) },
    { key: 'tracks', label: 'Tracks', icon: 'layers', to: { to: 'tracks' } },
    // The connect screen, the only one that names agents: switching there, then Continue, comes back here. The course
    // editor's route holds the roadmap it opened with, so it comes back on the saved draft, which has the edits since.
    { key: 'agent', label: 'Agent', icon: 'plug', to: async () => ({ to: 'connect', then: route.to === 'course' ? await editorRoute(api) : route }) },
  ];
  // The route on screen now, so an item that reads before it opens does nothing once the learner moved on.
  const shown = useRef<Route>(undefined);
  useEffect(() => {
    shown.current = route;
    return () => void (shown.current = undefined);
  }, [route]);
  async function open(to: Route | (() => Promise<Route>)) {
    const from = route;
    const target = typeof to === 'function' ? await to() : to;
    if (shown.current === from && !sameRoute(target, route)) go(target);
  }
  const nav = items.map((item) => (
    <button
      key={item.key}
      type="button"
      className="nav"
      // The slim sidebar shows icons alone: each is named in its tooltip too.
      title={slim ? item.label : undefined}
      aria-current={here === item.key ? 'page' : undefined}
      aria-label={slim ? item.label : undefined}
      onClick={() => void open(item.to).catch(fail)}
    >
      <Icon name={item.icon} color={here === item.key ? '#3DDB6C' : '#C9D5EA'} />
      {!slim && item.label}
    </button>
  ));
  if (slim) {
    return (
      <nav className="slim" aria-label="Main">
        {/* Emm, not the wordmark's "<" on its own: that reads as a Back button. */}
        <div className="lg"><Emm width={44} name={course?.track} /></div>
        {nav}
        <WorkNow course={course} slim />
        <UpdateNotice slim />
        <Courses slim />
      </nav>
    );
  }
  return (
    <nav className="side" aria-label="Main">
      <div className="logo"><Logo height={22} onNavy /></div>
      {nav}
      <WorkNow course={course} />
      <div className="foot">
        <UpdateNotice />
        <Courses />
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
function UpdateNotice({ slim = false }: { slim?: boolean }) {
  const api = useApi();
  const { route, fail } = useRouter();
  // Read until there is something to say: main checks at start and every 6 hours, so news can come at any time.
  const { data: update } = useLoad(() => api.update(), [route], { settled: (u) => u.kind === 'available' || u.kind === 'ready', every: 30_000 });
  // The slim sidebar has room for one word; the sentence is still read out.
  if (slim) {
    return (
      <div role="status" aria-label="Codemm updates" className="slim-update">
        {update?.kind === 'available' && (
          <>
            <span className="sr-only">A new version is available.</span>
            <ExternalLink href={update.url}>Update</ExternalLink>
          </>
        )}
        {update?.kind === 'ready' && (
          <>
            <span className="sr-only">A new version is ready.</span>
            <Button variant="text" onClick={() => void api.restartToUpdate().catch(fail)}>Restart</Button>
          </>
        )}
      </div>
    );
  }
  // One status region stays in place, so a screen reader hears the news when it arrives, without a focus move.
  return (
    <div role="status" aria-label="Codemm updates" className={update?.kind === 'available' || update?.kind === 'ready' ? 'update' : undefined}>
      {update?.kind === 'available' && (
        <>
          <span>A new version is available.</span>
          {/* The version is in the link, never in the words. */}
          <ExternalLink href={update.url}>Get it</ExternalLink>
        </>
      )}
      {update?.kind === 'ready' && (
        <>
          <span>A new version is ready.</span>
          <Button onClick={() => void api.restartToUpdate().catch(fail)}>Restart to update</Button>
        </>
      )}
    </div>
  );
}
