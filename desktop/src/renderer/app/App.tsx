import { useEffect, useMemo, useState } from 'react';
import type { CodemmApi } from '../../shared/api';
import { Connect } from '../features/connect/Connect';
import { Welcome } from '../features/connect/Welcome';
import { CourseEditor } from '../features/course/CourseEditor';
import { Goal } from '../features/learn/Goal';
import { LessonPage } from '../features/lessons/LessonPage';
import { TopicPage } from '../features/lessons/TopicPage';
import { Practice } from '../features/practice/Practice';
import { CourseMap } from '../features/progress/CourseMap';
import { Research } from '../features/research/Research';
import { Tracks } from '../features/tracks/Tracks';
import { ApiContext } from './api';
import { useFocusOnNavigate } from './focus';
import { NavContext, type Nav, type Route } from './nav';
import { Frame, RailLayout, SideLayout } from './Shell';

function Screen({ route }: { route: Route }) {
  switch (route.to) {
    case 'welcome': return <Welcome connected={false} />;
    case 'connect': return <Connect />;
    case 'ready': return <Welcome connected />;
    case 'goal': return <SideLayout on="learn"><Goal /></SideLayout>;
    case 'research': return <SideLayout on="learn"><Research goal={route.goal} /></SideLayout>;
    case 'draft': return <SideLayout on="learn"><CourseEditor draft={route.draft} /></SideLayout>;
    case 'course': return <SideLayout on="learn"><CourseMap /></SideLayout>;
    case 'topic': return <SideLayout on="learn"><TopicPage topicId={route.topicId} /></SideLayout>;
    case 'lesson': return <RailLayout on="learn"><LessonPage lessonId={route.lessonId} /></RailLayout>;
    case 'practice': return <RailLayout on="practice"><Practice exerciseId={route.exerciseId} /></RailLayout>;
    case 'tracks': return <SideLayout on="tracks"><Tracks /></SideLayout>;
  }
}

/** Picks the first screen: welcome until an agent connects, then the course or a new goal. */
async function firstRoute(api: CodemmApi): Promise<{ route: Route; courseId?: string }> {
  const [agents, courses] = await Promise.all([api.listAgents(), api.listCourses()]);
  if (!agents.some((a) => a.state === 'connected')) return { route: { to: 'welcome' } };
  if (courses[0]) return { route: { to: 'course' }, courseId: courses[0].id };
  return { route: { to: 'goal' } };
}

export function App({ api }: { api: CodemmApi }) {
  const [route, setRoute] = useState<Route>();
  const [courseId, setCourseId] = useState<string>();

  useEffect(() => {
    firstRoute(api).then((first) => {
      setCourseId(first.courseId);
      setRoute(first.route);
    });
  }, [api]);

  useFocusOnNavigate(route);

  const nav = useMemo<Nav | undefined>(
    () => route && { route, go: setRoute, courseId, openCourse: setCourseId },
    [route, courseId],
  );

  return (
    <ApiContext.Provider value={api}>
      <Frame>
        {nav && (
          <NavContext.Provider value={nav}>
            <Screen key={JSON.stringify(nav.route)} route={nav.route} />
          </NavContext.Provider>
        )}
      </Frame>
    </ApiContext.Provider>
  );
}
