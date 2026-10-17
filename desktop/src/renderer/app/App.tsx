import { useMemo, useState } from 'react';
import type { CodemmApi } from '../../shared/api';
import { Connect } from '../features/connect/Connect';
import { Welcome } from '../features/connect/Welcome';
import { Computer } from '../features/computer/Computer';
import { CourseEditor } from '../features/course/CourseEditor';
import { Goal } from '../features/learn/Goal';
import { Lesson } from '../features/lessons/Lesson';
import { TopicPage } from '../features/lessons/TopicPage';
import { Practice } from '../features/practice/Practice';
import { CourseMap } from '../features/progress/CourseMap';
import { Research } from '../features/research/Research';
import { Tracks } from '../features/tracks/Tracks';
import { Button } from '../ui/Button';
import { ApiContext } from './api';
import { RouterContext, type Route, type Router } from './router';
import { WithSide } from './Shell';

function Screen({ route }: { route: Route }) {
  switch (route.to) {
    case 'welcome':
      return <Welcome />;
    case 'connect':
      return <Connect />;
    case 'computer':
      return <Computer then={route.then} />;
    case 'goal':
      return <WithSide><Goal /></WithSide>;
    case 'research':
      return <WithSide><Research goal={route.goal} /></WithSide>;
    case 'course':
      return <WithSide><CourseEditor draft={route.draft} /></WithSide>;
    case 'topic':
      return <WithSide><TopicPage topicId={route.topicId} /></WithSide>;
    case 'learn':
      return <WithSide><CourseMap /></WithSide>;
    case 'tracks':
      return <WithSide><Tracks /></WithSide>;
    case 'lesson':
      return <Lesson key={route.lessonId} lessonId={route.lessonId} />;
    case 'practice':
      return <Practice key={route.activityId} activityId={route.activityId} />;
  }
}

export function App({ api, start = { to: 'welcome' } }: { api: CodemmApi; start?: Route }) {
  const [route, setRoute] = useState<Route>(start);
  const [failed, setFailed] = useState(false);
  const router = useMemo<Router>(
    () => ({
      route,
      go: (next) => {
        setFailed(false);
        setRoute(next);
      },
      fail: (error) => {
        console.error(error);
        setFailed(true);
      },
    }),
    [route],
  );
  return (
    <ApiContext.Provider value={api}>
      <RouterContext.Provider value={router}>
        <div className="win">
          <div className="tbar">Codemm</div>
          <div className="wbody">
            <Screen route={route} />
          </div>
          {failed && (
            <div className="failed" role="alert">
              That didn't work. Try again.
              <Button variant="text" onClick={() => setFailed(false)}>Dismiss</Button>
            </div>
          )}
        </div>
      </RouterContext.Provider>
    </ApiContext.Provider>
  );
}
