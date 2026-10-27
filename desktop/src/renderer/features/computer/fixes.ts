import type { CheckId, ComputerCheck, DockerInstall, Platform } from '../../../shared/api';

export interface Fix {
  steps: string[];
  link?: { label: string; url: string };
}

export const CHECK_NAMES: Record<CheckId, string> = {
  'docker-installed': 'Docker is installed',
  'docker-running': 'Docker is running',
  sandbox: 'The sandbox works',
};

/** Docker isn't ready, but practice runs on the WASI engine (core §4.5): the learner can go on, and Docker stays an option. */
export const WITHOUT_DOCKER = 'Codemm can run practice on this computer without Docker, for programs that read input and print output. For everything else, install Docker.';

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
  terms: "Docker's terms apply.",
  termsUrl: 'https://www.docker.com/legal/docker-subscription-service-agreement/',
  phase: {
    // Windows' permission prompt can open behind Codemm, flashing in the taskbar.
    wsl: 'Allow WSL, which Docker needs, when Windows asks (look in the taskbar).',
    downloading: 'Downloading Docker Desktop',
    checking: "Checking it's from Docker…",
    installing: 'Installing Docker…',
    admin: "Allow Docker's installer when Windows asks (look in the taskbar).",
    starting: "Opening Docker. When it asks, accept Docker's terms in its window.",
  },
  problem: {
    offline: "You're offline. Connect to the internet, then try again.",
    disk: 'Not enough disk space. Free up a few GB, then try again.',
    'macos-version': 'Docker Desktop needs macOS 14 or later. Update macOS to install it.',
    'windows-version': 'Docker Desktop needs Windows 10 22H2, or Windows 11 23H2 or later. Docker no longer supports older versions, so update Windows first.',
    'windows-server': "Docker Desktop doesn't run on Windows Server.",
    unverified: "The download wasn't signed by Docker, so Codemm deleted it.",
    manual: 'Drag Docker to Applications in the window that opened.',
    declined: 'Windows asks for permission first. Try again, and choose Yes.',
    'wsl-failed': "WSL's setup didn't finish.",
    restart: 'Restart Windows, then open Codemm again.',
    failed: "Docker's installer didn't finish.",
  } satisfies Record<NonNullable<DockerInstall['problem']>, string>,
  /** Problems where trying again can help; the others need the learner first. */
  retry: new Set<DockerInstall['problem']>(['offline', 'disk', 'unverified', 'declined', 'wsl-failed', 'failed']),
};

/** WSL's setup, which the running row offers on Windows when that's what Docker's engine needs (§6.1). */
export const WSL_STEP: Partial<Record<NonNullable<ComputerCheck['detail']>, string>> = { 'wsl-missing': 'Set up WSL', 'wsl-old': 'Update WSL' };

/** A running problem with a known cause replaces the usual fix (§6.1). */
export const DETAILS: Record<NonNullable<ComputerCheck['detail']>, { fix: Fix; notYet: string }> = {
  starting: {
    fix: { steps: ['Docker is starting. This can take a few minutes.'] },
    notYet: 'Docker is starting.',
  },
  'windows-containers': {
    fix: { steps: ['Switch Docker Desktop to Linux containers: right-click the Docker icon, then choose Switch to Linux containers.'] },
    notYet: 'Docker Desktop is set to Windows containers.',
  },
  'wsl-missing': {
    fix: {
      steps: ["Docker needs WSL, Windows' own Linux support. Set it up, then restart Windows."],
      link: { label: "Microsoft's steps", url: 'https://learn.microsoft.com/windows/wsl/install' },
    },
    notYet: 'Docker needs WSL.',
  },
  'wsl-old': {
    fix: {
      steps: ['Docker needs a newer WSL. Update it, then check again.'],
      link: { label: "Microsoft's steps", url: 'https://learn.microsoft.com/windows/wsl/install' },
    },
    notYet: 'WSL needs an update.',
  },
  virtualization: {
    fix: {
      steps: ["Turn on virtualization in this PC's BIOS or UEFI settings, then start Windows again. Your PC maker's site shows how."],
      link: { label: 'How to turn it on', url: 'https://support.microsoft.com/windows/enable-virtualization-on-windows-c5578302-6e43-4b4b-a449-8ced115f58e1' },
    },
    notYet: 'Virtualization is off on this PC.',
  },
  restart: {
    fix: { steps: ['Restart Windows to finish setting up Docker. Save your work in other apps first.'] },
    notYet: 'Windows needs a restart.',
  },
  checking: {
    fix: { steps: ['Still checking. This can take a minute after Docker starts.'] },
    notYet: 'Docker just started.',
  },
};

const RESTART: Fix = {
  steps: ['Restart Docker, then check again.'],
};

/**
 * The sandbox's self-test, when it knows the cause (§6.1): its own words, which say what to do. Restart Docker
 * follows only what it saw without knowing why.
 */
export const REASON = {
  fix: (r: NonNullable<ComputerCheck['reason']>): Fix => ({ steps: [r.text, ...(r.inconclusive ? RESTART.steps : [])] }),
  notYet: { offline: "You're offline.", disk: 'Docker ran out of disk space.', docker: NOT_YET.sandbox } satisfies Record<NonNullable<ComputerCheck['reason']>['kind'], string>,
};

/** Step-by-step fixes per computer. Links go to the makers' official pages only. */
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
