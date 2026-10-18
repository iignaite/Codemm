import { useEffect, useState, type CSSProperties } from 'react';
import type { JobProgress, JobStep } from '../../shared/api';
import { JOB_STAGES } from '../../shared/progress';
import type { HeardJob } from '../app/useJob';

/** After this long with no event while the agent holds the turn, a quiet line says it is still working (§4.11). */
export const QUIET_MS = 90_000;

export const sayStep = (step: JobStep) => (step.kind === 'search' ? `Searching ${step.query}` : step.kind === 'read' ? `Reading ${step.url}` : step.label);

/** What the job is doing now: a retry, or its latest step. */
export function nowLine(p: JobProgress): string | undefined {
  if (p.retry) return `Trying again (${p.retry.attempt} of ${p.retry.of})`;
  return p.steps[0] && sayStep(p.steps[0]);
}

/** A real fraction within the stage: a setup's build steps, or which exercise gate runs. */
const partOf = (p: JobProgress) => (p.part && p.part.total > 0 ? (p.kind === 'setup' ? `Step ${p.part.done} of ${p.part.total}` : `${p.part.done} of ${p.part.total}`) : undefined);

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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
  /** The bar's accessible name, for example "Writing the lesson". */
  label: string;
  /** Narrow places (the outline): the stages as bars, then the current stage's name or a retry, without the latest step. */
  compact?: boolean;
  /** Hides the latest-step line, for a screen that lists the steps itself (research). */
  noLine?: boolean;
};

/** A job's stages, each lit once reached, with its latest step and elapsed time. Never a percentage it doesn't have. */
export function JobBar({ job, label, compact = false, noLine = false }: Props) {
  const { progress: p, at } = job;
  const now = useNow();
  const since = Math.max(0, now - at);
  const stages = JOB_STAGES[p.kind];
  const stage = Math.min(p.stage, stages.length - 1);
  // Compact names the current stage, or a retry: narrow places have no room for every step.
  const line = noLine ? undefined : compact ? (p.retry ? nowLine(p) : stages[stage]) : nowLine(p);
  const quiet = p.thinking && p.idleMs + since >= QUIET_MS;
  const part = partOf(p);
  // The current stage's bar fills as far as its real fraction, when it has one.
  const fill = p.part && p.part.total > 0 ? ({ '--part': `${Math.round((100 * Math.min(p.part.done, p.part.total)) / p.part.total)}%` } as CSSProperties) : undefined;
  return (
    <div className={`job${compact ? ' compact' : ''}`} role="group" aria-label={label}>
      {stages.length > 1 && (
        <ol className="stages">
          {stages.map((s, i) => (
            <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : undefined} aria-current={i === stage ? 'step' : undefined} style={i === stage ? fill : undefined}>
              <span className={compact ? 'sr-only' : undefined}>{s}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="job-now">
        <span aria-live="polite">{[line, part].filter(Boolean).join(' ')}</span>
        <span className="job-time" role="timer" aria-label="Time so far">{clock(p.elapsedMs + since)}</span>
      </div>
      {quiet && !compact && <p className="quiet-text">Still working: the agent is thinking.</p>}
    </div>
  );
}
