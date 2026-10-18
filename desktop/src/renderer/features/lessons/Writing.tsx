import type { JobKind } from '../../../shared/api';
import { useJob } from '../../app/useJob';
import { JobBar } from '../../ui/JobBar';

/** A topic's lesson or activity being written: its job's stages once the job runs, a quiet shimmer while it waits its turn. */
export function Writing({ kind, concept, label, compact = false, width = '60%' }: { kind: Extract<JobKind, 'lesson' | 'author'>; concept: string; label: string; compact?: boolean; width?: number | string }) {
  const job = useJob((p) => p.kind === kind && p.concept === concept, [kind, concept]);
  if (job) return <JobBar job={job} label={label} compact={compact} />;
  return <span className="shim" style={{ width }} role="img" aria-label={label} />;
}
