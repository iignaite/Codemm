import type { CSSProperties } from 'react';
import type { CourseView, TopicView } from '../../../shared/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { continueRoute, offeredTopic, reviewText } from '../../app/course';
import { Writing } from '../lessons/Writing';

const STATE_LABEL = { mastered: 'Mastered', now: 'Now', later: 'Later' } as const;
/** Each stop lands this long after the one before it, so the branch fills in order; past the first few, all at once. */
const STEP_MS = 140;
const STAGGERED = 8;

/** The topic Codemm offers now: a due (or being written) review, otherwise the current topic. */
function currentIndex(topics: TopicView[]): number {
  const offered = offeredTopic(topics);
  return offered ? topics.indexOf(offered) : -1;
}

/**
 * The course as a path along Emm's branch: each topic is a leaf, the branch is green between topics the learner has
 * reached, and Emm sits on the topic Codemm offers now. A finished course has Emm at the branch's end.
 */
export function Path({ course }: { course: CourseView }) {
  const { topics } = course;
  const at = currentIndex(topics);
  // Reached: mastered, or the current topic. A topic passed over (skipped, or locked behind the current one) sits on grey.
  const reached = topics.map((t, i) => t.state === 'mastered' || i === at);
  return (
    <div className="path-wrap">
      <ol className="path" aria-label="Topics">
        {topics.map((t, i) => (
          <Stop key={t.id} topic={t} index={i} current={i === at} track={course.track} up={i > 0 && reached[i - 1] && reached[i]} down={i < topics.length - 1 && reached[i] && reached[i + 1]} last={i === topics.length - 1} />
        ))}
      </ol>
      {at < 0 && course.done && (
        <div className="path-end" aria-hidden="true" style={timing(topics.length)}>
          <Emm mood="cheer" width={96} name={course.track} />
        </div>
      )}
    </div>
  );
}

/** When a stop's part of the sequence starts: the CSS times the branch, leaf, title and Emm from it. */
const timing = (i: number): CSSProperties => ({ '--d': `${Math.min(i, STAGGERED) * STEP_MS}ms` }) as CSSProperties;

type StopProps = { topic: TopicView; index: number; current: boolean; track: string; up: boolean; down: boolean; last: boolean };

/** One topic on the path: its leaf on the branch, then its title, or the current topic's card with Emm on it. */
function Stop({ topic, index, current, track, up, down, last }: StopProps) {
  const { go } = useRouter();
  return (
    <li className={`stop ${topic.state}${current ? ' current' : ''}`} style={timing(index)} aria-current={current ? 'step' : undefined}>
      <span className="vine" aria-hidden="true">
        {index > 0 && <i className={`seg up${up ? ' on' : ''}`} />}
        {!last && <i className={`seg down${down ? ' on' : ''}`} />}
      </span>
      <Leaf state={topic.state} flip={index % 2 === 1} />
      {current ? (
        <Current topic={topic} track={track} />
      ) : topic.state === 'mastered' ? (
        <div className="stop-row">
          {/* A mastered topic opens again: its lessons and the activity, to reread or practise. */}
          <button type="button" className="stop-name link" onClick={() => go({ to: 'topic', topicId: topic.id })}>{topic.title}</button>
          {topic.reviewIn && <span className="soon">{reviewText(topic.reviewIn)}</span>}
        </div>
      ) : (
        <div className="stop-row">
          <span className="stop-name">{topic.title}</span>
        </div>
      )}
    </li>
  );
}

/** A topic's state as a leaf on the branch: filled with a check when mastered, outlined while it waits. */
function Leaf({ state, flip }: { state: TopicView['state']; flip: boolean }) {
  return (
    <span className={`leaf ${state}${flip ? ' flip' : ''}`} role="img" aria-label={STATE_LABEL[state]}>
      <svg className="blade-art" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
        <path className="blade" d="M5 31 C 5 15, 15 5, 31 5 C 31 21, 21 31, 5 31 Z" />
      </svg>
      {state === 'mastered' && <Icon name="check" color="#fff" size={15} />}
      {state === 'now' && <Icon name="code" color="var(--green-ink)" size={15} />}
      {state === 'later' && <Icon name="lock" color="var(--faint)" size={13} />}
    </span>
  );
}

/** The topic Codemm offers now, with Emm perched on its card: Continue, or a due review. */
function Current({ topic, track }: { topic: TopicView; track: string }) {
  const { go } = useRouter();
  const mood = topic.review ? 'look' : topic.stuck ? 'think' : 'ready';
  return (
    <div className="stop-card">
      <span className="perch" aria-hidden="true">
        <Emm mood={mood} width={84} name={track} />
      </span>
      <div className="stop-main">
        <b className="stop-title">{topic.title}</b>
        {topic.review === 'writing' ? (
          <Writing kind="author" concept={topic.id} label="Writing the review" compact waiting="Writing the review" />
        ) : (
          !topic.review && <Steps topic={topic} />
        )}
      </div>
      {topic.review === 'writing' ? null : topic.review === 'due' ? (
        <Button onClick={() => go({ to: 'practice', concept: topic.id })}>Review</Button>
      ) : (
        <Button onClick={() => go(continueRoute(topic))}>Continue</Button>
      )}
    </div>
  );
}

/** How far into the topic: one step per lesson, then the activity. The words say the lessons read. */
function Steps({ topic }: { topic: TopicView }) {
  const read = topic.lessons.filter((l) => l.state === 'read').length;
  const all = topic.lessons.length > 0 && read === topic.lessons.length;
  return (
    <div className="steps">
      <span className="step-bar" aria-hidden="true">
        {topic.lessons.map((l) => <i key={l.id} className={l.state} />)}
        <i className={`act ${topic.activity}`} />
      </span>
      {all ? (
        <span className="done"><Icon name="check" color="var(--green-ink)" size={14} />Lessons</span>
      ) : (
        topic.lessons.length > 0 && <span className="step-text">Lessons {read} of {topic.lessons.length}</span>
      )}
    </div>
  );
}
