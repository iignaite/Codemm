// One way for the e2e specs to start the built app with the mock (CODEMM_MOCK): `launch(scenario)` from the test's
// fixtures. Every app a test launched is closed when the test ends, even when it fails, so none outlives its test.
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

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
    await use(async (scenario = '', { args = [], env = {} } = {}) => {
      const app = await electron.launch({ args: ['.', ...args], env: { ...process.env, CODEMM_MOCK: scenario, ...env } });
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
  },
});

export { expect } from '@playwright/test';
