import type { TopicView } from '../../../shared/api';
import { useRouter } from '../../app/router';
import { Icon } from '../../ui/Icon';
import { Writing } from './Writing';

/** The topic's lessons and activity, beside a lesson. */
export function Outline({ topic, current }: { topic: TopicView; current: string }) {
  const { go } = useRouter();
  const open = topic.activity === 'open' || topic.activity === 'passed';
  return (
    <nav className="stmt outline" aria-label={topic.title}>
      <h2 className="h3">{topic.title}</h2>
      {topic.lessons.map((l) =>
        l.state === 'writing' ? (
          <div key={l.id} className="item writing">
            <span className="item-head"><Icon name="book" color="#5B6A84" size={18} />{l.title}</span>
            <Writing kind="lesson" concept={topic.id} label="Writing the lesson" compact width={48} />
          </div>
        ) : (
          <button key={l.id} type="button" className="item link" aria-current={l.id === current ? 'page' : undefined} onClick={() => go({ to: 'lesson', lessonId: l.id })}>
            <Icon name="book" color={l.id === current ? '#0E7C35' : '#4A5B7A'} size={18} />
            <span style={{ flex: 1 }}>{l.title}</span>
            {l.state === 'read' && <span role="img" aria-label="Read"><Icon name="check" color="#0E7C35" size={14} /></span>}
          </button>
        ),
      )}
      {open ? (
        <button type="button" className="item link" onClick={() => go({ to: 'practice', concept: topic.id })}>
          <Icon name="code" color="#0E2754" size={18} />
          Activity
        </button>
      ) : topic.activity === 'writing' ? (
        <div className="item writing">
          <span className="item-head"><Icon name="code" color="#5B6A84" size={18} />Activity</span>
          <Writing kind="author" concept={topic.id} label="Writing the activity" compact width={48} />
        </div>
      ) : (
        <span className="item">
          <Icon name="code" color="#5B6A84" size={18} />
          <span style={{ flex: 1 }}>Activity</span>
        </span>
      )}
    </nav>
  );
}
