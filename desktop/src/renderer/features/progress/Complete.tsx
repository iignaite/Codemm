import type { Course } from '../../../shared/api';
import { useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { paletteFor } from '../../ui/palette';

/** Every topic pops in. Then pick anything next. */
export function Complete({ course }: { course: Course }) {
  const { go } = useNav();
  return (
    <main className="center">
      <div style={{ width: 760, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26, textAlign: 'center' }}>
        <Emm mood="cheer" width={240} palette={paletteFor(course.title)} />
        <h1 className="h1 a-up" style={stagger(0, 200)}>{course.title} complete</h1>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, width: '100%' }}>
          {course.topics.map((t, i) => (
            <li key={t.id} className="pill green a-pop" style={{ ...stagger(i, 400), height: 36, justifyContent: 'center', fontSize: 13.5 }}>
              <Icon name="check" color="#0E7C35" size={12} />{t.title}
            </li>
          ))}
        </ul>
        <Button size="lg" className="a-up" style={stagger(0, 1500)} onClick={() => go({ to: 'goal' })}>Learn something new</Button>
      </div>
    </main>
  );
}
