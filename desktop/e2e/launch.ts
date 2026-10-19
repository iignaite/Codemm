// One way for the e2e specs to start the built app with the mock (CODEMM_MOCK): `launch(scenario)` from the test's
// fixtures. Every app a test launched is closed when the test ends, even when it fails, so none outlives its test.
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LaunchOptions {
  /** More command-line arguments after the app's folder. */
  args?: string[];
  /** More environment variables. */
  env?: Record<string, string>;
}

export type Launch = (scenario?: string, options?: LaunchOptions) => Promise<{ app: ElectronApplication; page: Page }>;

export const test = base.extend<{ launch: Launch; settled: boolean }>({
  /** For accessibility scans: 100% zoom (Chromium keeps a zoom level per origin across launches) and reduced motion. */
  settled: [false, { option: true }],
  launch: async ({ settled }, use) => {
    const apps: ElectronApplication[] = [];
    // The test's own profile unless it names one, never the learner's: Codemm runs once per profile (DESIGN §2).
    const profile = mkdtempSync(join(tmpdir(), 'codemm-e2e-profile-'));
    await use(async (scenario = '', { args = [], env = {} } = {}) => {
      const own = args.some((a) => a.startsWith('--user-data-dir=')) ? [] : [`--user-data-dir=${profile}`];
      const app = await electron.launch({ args: ['.', ...own, ...args], env: { ...process.env, CODEMM_MOCK: scenario, ...env } });
      apps.push(app);
      const page = await app.firstWindow();
      if (settled) {
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
        // Animations finish at once, so every scan sees the settled screen.
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
      return { app, page };
    });
    await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still in use: the OS clears its temp folder.
    }
  },
});

export { expect } from '@playwright/test';
