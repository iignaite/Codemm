import type { TopicView } from '../../../shared/api';
import { useRouter } from '../../app/router';
import { Icon } from '../../ui/Icon';
import { Writing } from './Writing';

/** The topic's lessons and activity, beside a lesson. */
export function Outline({ topic, current }: { topic: TopicView; current: string }) {
  const { go } = useRouter();
  const open = topic.activity === 'open' || topic.activity === 'passed';
  const lessonWriting = topic.lessons.some((l) => l.state === 'writing');
  return (
    <nav className="stmt outline" aria-label={topic.title}>
      <h2 className="h3">{topic.title}</h2>
      {topic.lessons.map((l) =>
        l.state === 'failed' ? (
          <span key={l.id} className="item"><Icon name="book" color="var(--faint)" size={18} />Codemm couldn't write this lesson.</span>
        ) : l.state === 'writing' ? (
          <div key={l.id} className="item writing">
            <span className="item-head"><Icon name="book" color="var(--faint)" size={18} />{l.title}</span>
            <Writing kind="lesson" concept={topic.id} label="Writing the lesson" compact />
          </div>
        ) : (
          <button key={l.id} type="button" className="item link" aria-current={l.id === current ? 'page' : undefined} onClick={() => go({ to: 'lesson', lessonId: l.id })}>
            <Icon name="book" color={l.id === current ? 'var(--green-ink)' : 'var(--muted)'} size={18} />
            <span className="fill">{l.title}</span>
            {l.state === 'read' && <span role="img" aria-label="Read"><Icon name="check" color="var(--green-ink)" size={14} /></span>}
          </button>
        ),
      )}
      {topic.activity !== 'none' && (open ? (
        <button type="button" className="item link" onClick={() => go({ to: 'practice', concept: topic.id })}>
          <Icon name="code" color="var(--ink)" size={18} />
          Activity
        </button>
      ) : topic.activity === 'writing' ? (
        <div className="item writing">
          <span className="item-head"><Icon name="code" color="var(--faint)" size={18} />Activity</span>
          <Writing kind="author" concept={topic.id} label="Writing the activity" compact waiting={lessonWriting ? 'Waiting for the lesson' : undefined} />
        </div>
      ) : (
        <>
          <span className="item">
            <Icon name="code" color="var(--faint)" size={18} />
            <span className="fill">Activity</span>
          </span>
          {topic.activity === 'locked' && <span className="locked">Opens after you finish the lessons</span>}
        </>
      ))}
    </nav>
  );
}
