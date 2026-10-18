import type { CheckId, DockerInstall, Platform } from '../../../shared/api';

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
  steps: ['Open Docker Desktop, then wait until it says it is running.'],
};

/** Installing Docker Desktop for the learner (§6.1). The phase line names what is happening now. */
export const INSTALL = {
  terms: "Docker Desktop is free for personal use. Docker's terms apply.",
  termsUrl: 'https://www.docker.com/legal/docker-subscription-service-agreement/',
  phase: {
    downloading: 'Downloading Docker Desktop',
    checking: "Checking it's from Docker…",
    installing: { mac: 'Installing Docker…', windows: "Finish in Docker's installer.", linux: 'Installing Docker…' },
    starting: "Opening Docker. When it asks, accept Docker's terms in its window.",
  },
  problem: {
    offline: "You're offline. Connect to the internet, then try again.",
    disk: 'Not enough disk space. Free up a few GB, then try again.',
    unverified: "The download wasn't signed by Docker, so Codemm deleted it.",
    manual: 'Drag Docker to Applications in the window that opened.',
    restart: 'Restart Windows, then open Codemm again.',
    failed: "Docker's installer didn't finish.",
  } satisfies Record<NonNullable<DockerInstall['problem']>, string>,
  /** Problems where trying again can help; the others need the learner first. */
  retry: new Set<DockerInstall['problem']>(['offline', 'disk', 'unverified', 'failed']),
};

/** A running problem with a known cause replaces the usual fix (§6.1). */
export const DETAILS: Record<'starting' | 'windows-containers', { fix: Fix; notYet: string }> = {
  starting: {
    fix: { steps: ['Docker is starting. This can take a few minutes.'] },
    notYet: 'Docker is starting.',
  },
  'windows-containers': {
    fix: { steps: ['Switch Docker Desktop to Linux containers: right-click the Docker icon, then choose Switch to Linux containers.'] },
    notYet: 'Docker Desktop is set to Windows containers.',
  },
};

const RESTART: Fix = {
  steps: ['Restart Docker, then check again.'],
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
