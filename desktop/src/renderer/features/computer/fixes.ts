import type { CheckId, Platform } from '../../../shared/api';

export interface Fix {
  steps: string[];
  link?: { label: string; url: string };
}

export const CHECK_NAMES: Record<CheckId, string> = {
  'docker-installed': 'Docker is installed',
  'docker-running': 'Docker is running',
  'docker-access': 'Codemm can use Docker',
};

const DESKTOP_RUNNING: Fix = {
  steps: ['Open Docker Desktop.', 'Wait until it says Docker Desktop is running.'],
};

/** Step-by-step fixes per computer. Links go to Docker's official pages only. */
export const FIXES: Record<Platform, Partial<Record<CheckId, Fix>>> = {
  mac: {
    'docker-installed': {
      steps: [
        'Download Docker Desktop for Mac. Pick Apple silicon or Intel to match this Mac.',
        'Open the download and drag Docker to Applications.',
        'Open Docker from Applications and finish its setup.',
      ],
      link: { label: 'Get Docker Desktop', url: 'https://docs.docker.com/desktop/setup/install/mac-install/' },
    },
    'docker-running': DESKTOP_RUNNING,
  },
  windows: {
    'docker-installed': {
      steps: [
        'Download Docker Desktop for Windows.',
        'Run the installer and keep "Use WSL 2" selected.',
        'Restart if Windows asks, then open Docker Desktop.',
      ],
      link: { label: 'Get Docker Desktop', url: 'https://docs.docker.com/desktop/setup/install/windows-install/' },
    },
    'docker-running': DESKTOP_RUNNING,
  },
  linux: {
    'docker-installed': {
      steps: ['Install Docker Engine with the steps for your distribution.', 'Come back here when it is installed.'],
      link: { label: 'Get Docker Engine', url: 'https://docs.docker.com/engine/install/' },
    },
    'docker-running': {
      steps: ['Start Docker: sudo systemctl start docker', 'To start it with the computer: sudo systemctl enable docker'],
    },
    'docker-access': {
      steps: ['Add yourself to the docker group: sudo usermod -aG docker $USER', 'Log out and back in, then come back here.'],
      link: { label: 'Linux setup steps', url: 'https://docs.docker.com/engine/install/linux-postinstall/' },
    },
  },
};
