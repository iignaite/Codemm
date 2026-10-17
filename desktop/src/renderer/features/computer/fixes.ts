import type { CheckId, Platform } from '../../../shared/api';

export interface Fix {
  steps: string[];
  link?: { label: string; url: string };
}

export const CHECK_NAMES: Record<CheckId, string> = {
  'docker-installed': 'Docker is installed',
  'docker-running': 'Docker is running',
  sandbox: 'The sandbox works',
};

/** Said while a check needs a step. Never the learner's fault. */
export const NOT_YET: Record<CheckId, string> = {
  'docker-installed': "Docker isn't installed yet.",
  'docker-running': "Docker isn't running yet.",
  sandbox: "Codemm couldn't confirm the sandbox yet.",
};

const START_DESKTOP: Fix = {
  steps: ['Start Docker Desktop.', 'Wait until it says Docker Desktop is running.'],
};

const RESTART: Fix = {
  steps: ['Restart Docker.', 'Codemm checks again when it is back.'],
};

/** Step-by-step fixes per computer. Links go to Docker's official pages only. */
export const FIXES: Record<Platform, Record<CheckId, Fix>> = {
  mac: {
    'docker-installed': {
      steps: [
        'Install Docker Desktop. Pick Apple silicon or Intel to match this Mac.',
        'Open the download and drag Docker to Applications.',
        'Open Docker from Applications and finish its setup.',
      ],
      link: { label: 'Get Docker Desktop', url: 'https://docs.docker.com/desktop/setup/install/mac-install/' },
    },
    'docker-running': START_DESKTOP,
    sandbox: RESTART,
  },
  windows: {
    'docker-installed': {
      steps: [
        'Install Docker Desktop.',
        'In the installer, keep "Use WSL 2" selected. It installs WSL 2 if Windows needs it.',
        'Restart if Windows asks, then open Docker Desktop.',
      ],
      link: { label: 'Get Docker Desktop', url: 'https://docs.docker.com/desktop/setup/install/windows-install/' },
    },
    'docker-running': START_DESKTOP,
    sandbox: RESTART,
  },
  linux: {
    'docker-installed': {
      steps: ['Install Docker Engine with the steps for your distribution.', 'Come back here when it is installed.'],
      link: { label: 'Get Docker Engine', url: 'https://docs.docker.com/engine/install/' },
    },
    'docker-running': {
      steps: [
        'Start Docker: sudo systemctl start docker',
        'If Docker says permission denied: sudo usermod -aG docker $USER, then sign out and back in.',
      ],
      link: { label: 'Linux setup steps', url: 'https://docs.docker.com/engine/install/linux-postinstall/' },
    },
    sandbox: RESTART,
  },
};
