import { EmmFill } from './EmmFill';

/**
 * An install's progress (§6.1) as Emm filling up, like every other long step: one share per stage reached, the
 * download filling its own share with its real fraction (`part`, 0 to 1), beside the stage's words. Compact, for a
 * card. It shows no time: Codemm doesn't know when an install began.
 */
export function StageFill({ label, stages, stage, part = 0, text }: { label: string; stages: number; stage: number; part?: number; text: string }) {
  const within = Math.max(0, Math.min(1, part));
  const fill = Math.min(1, (stage + 1 + within) / (stages + 1));
  return (
    <div className="job compact install-fill">
      <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)} aria-valuetext={text}>
        <EmmFill value={fill} width={32} />
      </span>
      <span className="job-step">{text}</span>
    </div>
  );
}
