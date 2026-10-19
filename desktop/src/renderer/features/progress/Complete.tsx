import type { CourseView } from '../../../shared/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { reviewText } from '../../app/course';

/** Every topic pops in. Then pick anything next. */
export function Complete({ course, onView }: { course: CourseView; onView: () => void }) {
  const { go } = useRouter();
  return (
    <main className="center">
      <div className="complete">
        <Emm mood="cheer" width={240} name={course.track} perch />
        <h1 className="h1 a-up" style={stagger(0, 200)}>{course.title} complete</h1>
        <ul className="pills" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Mastered">
          {course.topics.map((t, i) => (
            <li key={t.id} className="pill a-pop" style={stagger(i, 400)}>
              <Icon name="check" color="#0E7C35" size={12} />
              {t.title}
            </li>
          ))}
        </ul>
        {course.topics.some((t) => t.reviewIn) && (
          <ul className="soon" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Reviews">
            {course.topics.filter((t) => t.reviewIn).map((t) => (
              <li key={t.id}>{t.title}: {reviewText(t.reviewIn!)}</li>
            ))}
          </ul>
        )}
        <div className="actions a-up" style={stagger(0, 1500)}>
          <Button variant="ghost" size="lg" onClick={onView}>View course</Button>
          <Button size="lg" onClick={() => go({ to: 'goal' })}>Learn something new</Button>
        </div>
      </div>
    </main>
  );
}
