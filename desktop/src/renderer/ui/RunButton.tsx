import { Button } from './Button';

/** Run, which turns into Stop on the same button, so keyboard focus stays on it. Stop is never disabled. */
export function RunButton({ running, onRun, onStop, disabled = false }: { running: boolean; onRun: () => void; onStop: () => void; disabled?: boolean }) {
  return <Button variant="ghost" disabled={disabled && !running} onClick={running ? onStop : onRun}>{running ? 'Stop' : 'Run'}</Button>;
}
