import type { DockerInstall, Platform } from '../../../shared/api';
import { StageFill } from '../../ui/StageFill';
import { INSTALL } from './fixes';

/** Windows sets up WSL first when it needs it. */
const STAGES = { mac: ['downloading', 'checking', 'installing', 'starting'], windows: ['wsl', 'downloading', 'checking', 'installing', 'starting'], linux: [] } as const;
type Stage = Exclude<DockerInstall['phase'], 'failed'>;

/** Codemm installing Docker Desktop (§6.1): Emm filling through WSL's setup, the download (its real fraction), the check, the install and Docker opening. */
export function DockerProgress({ install, platform }: { install: DockerInstall & { phase: Stage }; platform: Platform }) {
  const stages: readonly Stage[] = STAGES[platform];
  const text = INSTALL.phase[install.phase];
  const downloading = install.phase === 'downloading';
  const part = downloading ? (install.progress ?? 0) : 0;
  return (
    <StageFill
      label={text}
      stages={stages.length}
      stage={stages.indexOf(install.phase)}
      part={part}
      text={downloading ? `${text} ${Math.round(part * 100)}%` : text}
    />
  );
}
