import type { ReactNode } from 'react';
import type { Course } from '../../shared/api';
import { Icon, Mark, type IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { PALETTES, paletteFor } from '../ui/palette';
import { useLive } from './api';
import { continueRoute, useNav, type Route } from './nav';

export type Area = 'learn' | 'practice' | 'tracks';

const AREAS: [Area, string, IconName][] = [['learn', 'Learn', 'path'], ['practice', 'Practice', 'code'], ['tracks', 'Tracks', 'layers']];

export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="win">
      <div className="tbar">Codemm</div>
      <div className="wbody">{children}</div>
    </div>
  );
}

function useCourse(): Course | undefined {
  const { courseId } = useNav();
  return useLive((api) => (courseId ? api.getCourse(courseId) : Promise.resolve(undefined)), [courseId]);
}

function routeFor(area: Area, course?: Course): Route {
  if (area === 'tracks') return { to: 'tracks' };
  if (!course) return { to: 'goal' };
  const now = course.topics.find((t) => t.state === 'now');
  return area === 'practice' && now ? continueRoute(now) : { to: 'course' };
}

function NavButtons({ on, course, iconOnly }: { on: Area; course?: Course; iconOnly?: boolean }) {
  const { go } = useNav();
  return AREAS.map(([area, label, icon]) => (
    <button key={area} type="button" className="nav" aria-current={on === area ? 'page' : undefined}
      aria-label={iconOnly ? label : undefined} onClick={() => go(routeFor(area, course))}>
      <Icon name={icon} color={on === area ? '#3DDB6C' : '#C9D5EA'} />
      {!iconOnly && label}
    </button>
  ));
}

function CoursePicker({ course }: { course?: Course }) {
  const { go, openCourse } = useNav();
  const courses = useLive((api) => api.listCourses(), []) ?? [];
  if (!course) return <div className="pick none">No course yet</div>;
  return (
    <Menu label={`Switch course, ${course.title}`} className="pick" up
      button={<>
        <span className="badge" style={{ background: PALETTES[paletteFor(course.title)].badge }} aria-hidden="true">{course.title[0]}</span>
        <span style={{ flex: 1 }}>{course.title}</span>
        <Icon name="down" color="#AFC0DD" size={14} />
      </>}
      items={[
        ...courses.map((c) => ({ label: c.title, onSelect: () => { openCourse(c.id); go({ to: 'course' }); } })),
        { label: 'Learn something new', onSelect: () => go({ to: 'goal' }) },
      ]}
    />
  );
}

/** Sidebar layout for browsing: Learn, Practice, Tracks and the course picker. */
export function SideLayout({ on, children }: { on: Area; children: ReactNode }) {
  const course = useCourse();
  return (
    <>
      <nav className="side" aria-label="Main">
        <div className="logo"><Mark size={24} /><span aria-hidden="true">odemm</span></div>
        <NavButtons on={on} course={course} />
        <div className="foot"><CoursePicker course={course} /></div>
      </nav>
      {children}
    </>
  );
}

/** Slim rail layout for focused work: lessons and practice. */
export function RailLayout({ on, children }: { on: Area; children: ReactNode }) {
  const course = useCourse();
  return (
    <>
      <nav className="rail" aria-label="Main">
        <div className="lg"><Mark size={22} /></div>
        <NavButtons on={on} course={course} iconOnly />
      </nav>
      {children}
    </>
  );
}
