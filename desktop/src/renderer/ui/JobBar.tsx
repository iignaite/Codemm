import { useEffect, useState } from 'react';
import type { JobProgress, JobStep } from '../../shared/api';
import { JOB_STAGES } from '../../shared/progress';
import type { HeardJob } from '../app/useJob';
import { EmmFill } from './EmmFill';

/** After this long with no event while the agent holds the turn, a quiet line says it is still working (§4.11). */
export const QUIET_MS = 90_000;

export const sayStep = (step: JobStep) => (step.kind === 'search' ? `Searching ${step.query}` : step.kind === 'read' ? `Reading ${step.url}` : step.label);

/** What the job is doing now: a retry, or its latest step. */
export function nowLine(p: JobProgress): string | undefined {
  if (p.retry) return `Trying again (${p.retry.attempt} of ${p.retry.of})`;
  return p.steps[0] && sayStep(p.steps[0]);
}

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * How far Emm fills: each stage reached fills its share, and the last share is the job done (a tutor turn, with one
 * stage, is half full while it answers). Never a percentage the job doesn't have.
 */
export const fillOf = (p: JobProgress) => Math.min(1, (p.stage + 1) / (JOB_STAGES[p.kind].length + 1));

/** Ticks once a second, for the elapsed time. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type Props = {
  job: HeardJob;
  /** The progress's accessible name, for example "Writing the lesson". */
  label: string;
  /** Narrow places (the outline): a small Emm and one line, the step and the time. */
  compact?: boolean;
  /** Hides the latest-step line, for a screen that lists the steps itself (research). */
  noLine?: boolean;
  /** False when the screen's own Emm shows the fill (research's heading). */
  emm?: boolean;
};

/**
 * A job's progress as Emm filling up, from grey to Codemm green, as the job reaches each stage (§4.11). Full: the
 * named stages, the latest step or retry, the time so far, and a quiet line after 90 seconds. Compact: one line.
 */
export function JobBar({ job, label, compact = false, noLine = false, emm = true }: Props) {
  const { progress: p, at } = job;
  const now = useNow();
  const since = Math.max(0, now - at);
  const stages = JOB_STAGES[p.kind];
  const stage = Math.min(p.stage, stages.length - 1);
  const elapsed = clock(p.elapsedMs + since);
  const quiet = p.thinking && p.idleMs + since >= QUIET_MS;
  const line = nowLine(p);
  const fill = fillOf(p);
  const dim = Boolean(p.retry) || quiet;
  const meter = (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fill * 100)}
      aria-valuetext={`${p.retry ? line : stages[stage]}, ${elapsed}`}
    >
      {emm && <EmmFill value={fill} width={compact ? 32 : 84} dim={dim} />}
    </span>
  );
  if (compact) {
    return (
      <div className="job compact" role="group" aria-label={label}>
        {meter}
        {/* The outline is narrow: a retry reads "Try 2 of 3" here; screen readers hear it whole. */}
        <span className="job-step">{p.retry ? `Try ${p.retry.attempt} of ${p.retry.of}` : (line ?? stages[stage])}</span>
        <span className="job-time">{elapsed}</span>
      </div>
    );
  }
  return (
    <div className={`job full${emm ? '' : ' bare'}`} role="group" aria-label={label}>
      {meter}
      <div className="job-body">
        <div className="job-line">
          {stages.length > 1 && (
            <ol className="stages">
              {stages.map((s, i) => (
                <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : undefined} aria-current={i === stage ? 'step' : undefined}>{s}</li>
              ))}
            </ol>
          )}
          <span className="job-time">{elapsed}</span>
        </div>
        <span className="job-step" aria-live="polite">{noLine ? (p.retry ? line : undefined) : line}</span>
        {quiet && <p className="quiet-text">Still working: the agent is thinking.</p>}
      </div>
    </div>
  );
}
