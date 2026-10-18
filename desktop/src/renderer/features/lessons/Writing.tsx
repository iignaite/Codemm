import type { JobKind } from '../../../shared/api';
import { useJob } from '../../app/useJob';
import { JobBar } from '../../ui/JobBar';

/**
 * A topic's lesson or activity being written: its job's progress once the job runs. While it waits its turn it shows
 * `waiting` quietly ("Waiting for the lesson"), or nothing but its name for screen readers.
 */
export function Writing({ kind, concept, label, compact = false, waiting }: { kind: Extract<JobKind, 'lesson' | 'author'>; concept: string; label: string; compact?: boolean; waiting?: string }) {
  const job = useJob((p) => p.kind === kind && p.concept === concept, [kind, concept]);
  if (job) return <JobBar job={job} label={label} compact={compact} />;
  return waiting ? <span className="quiet-text waiting">{waiting}</span> : <span className="sr-only">{label}</span>;
}
