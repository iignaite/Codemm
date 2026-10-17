import type { CourseView } from '../../../shared/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** Every topic pops in. Then pick anything next. */
export function Complete({ course }: { course: CourseView }) {
  const { go } = useRouter();
  return (
    <main className="center">
      <div className="complete">
        <Emm mood="cheer" width={240} name={course.track} perch />
        <h1 className="h1 a-up" style={stagger(0, 200)}>{course.goal} complete</h1>
        <ul className="pills" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Mastered">
          {course.topics.map((t, i) => (
            <li key={t.id} className="pill a-pop" style={stagger(i, 400)}>
              <Icon name="check" color="#0E7C35" size={12} />
              {t.title}
            </li>
          ))}
        </ul>
        <Button size="lg" className="a-up" style={stagger(0, 1500)} onClick={() => go({ to: 'goal' })}>Learn something new</Button>
      </div>
    </main>
  );
}
