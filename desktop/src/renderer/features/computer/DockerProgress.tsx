import type { DockerInstall, Platform } from '../../../shared/api';
import { StageFill } from '../../ui/StageFill';
import { INSTALL } from './fixes';

const STAGES = ['downloading', 'checking', 'installing', 'starting'] as const;

/** Codemm installing Docker Desktop (§6.1): Emm filling through the download (its real fraction), the check, the install and Docker opening. */
export function DockerProgress({ install, platform }: { install: DockerInstall & { phase: (typeof STAGES)[number] }; platform: Platform }) {
  const text = install.phase === 'installing' ? INSTALL.phase.installing[platform] : INSTALL.phase[install.phase];
  const downloading = install.phase === 'downloading';
  const part = downloading ? (install.progress ?? 0) : 0;
  return (
    <StageFill
      label={text}
      stages={STAGES.length}
      stage={STAGES.indexOf(install.phase)}
      part={part}
      text={downloading ? `${text} ${Math.round(part * 100)}%` : text}
    />
  );
}
