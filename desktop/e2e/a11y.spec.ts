import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

// D16: WCAG AA on every screen, the journey by keyboard alone, and reduced motion.
// Runs the built app with the mock (CODEMM_MOCK), like smoke.spec.ts.

const AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function launch(scenario = ''): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: scenario } });
  const page = await app.firstWindow();
  // Chromium keeps a zoom level per origin across launches; every test starts at 100%.
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  // Animations finish at once, so every scan sees the settled screen.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { app, page };
}

/** Fails with every WCAG A and AA violation on the screen as it is now. */
async function audit(page: Page, screen: string) {
  // Legacy mode runs axe in the page itself: Electron can't open the extra page the default mode needs.
  const { violations } = await new AxeBuilder({ page }).withTags(AA).setLegacyMode().analyze();
  expect(violations.map((v) => `${screen}: ${v.id} on ${v.nodes.map((n) => `${n.target.join(' ')} (${n.failureSummary?.split('\n')[1]?.trim()})`).join(', ')}`)).toEqual([]);
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });

async function connect(page: Page) {
  await button(page, 'Connect an agent').click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button(page, 'Continue').click();
}

/** The mock's own API, through the preload bridge: finishes every topic, like a learner would. */
async function masterEverything(page: Page) {
  await page.evaluate(async () => {
    const call = (method: string, ...args: unknown[]) => (window as never as { codemm: { invoke: (m: string, a: unknown[]) => Promise<any> } }).codemm.invoke(method, args);
    for (let course = await call('course'); course.topics.some((t: { state: string }) => t.state !== 'mastered'); course = await call('course')) {
      const now = course.topics.find((t: { state: string }) => t.state === 'now');
      if (!now) continue;
      for (const l of now.lessons) await call('markRead', l.id);
      const { id, files } = await call('activity', now.id);
      await call('saveFile', id, files[0].path, 'count + 1', files[0].digest);
      await call('check', id);
    }
  });
}

async function toActivity(page: Page) {
  await toRoadmap(page);
  await button(page, 'Approve').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await button(page, 'Read What javascript basics is').click();
  await button(page, 'Next').click();
  await button(page, 'Next').click();
  await expect(heading(page, 'Click Counter')).toBeVisible();
}

async function toRoadmap(page: Page) {
  await connect(page);
  await expect(page.getByText('This computer is ready.')).toBeVisible();
  await button(page, 'Continue').click();
  await button(page, 'Start learning').click();
  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await button(page, 'Start').click();
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
}

test('every screen of the journey passes WCAG AA checks', async () => {
  const { app, page } = await launch();
  await audit(page, 'welcome');
  await button(page, 'Connect an agent').click();
  await audit(page, 'connect');
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button(page, 'Continue').click();
  await expect(page.getByText('This computer is ready.')).toBeVisible();
  await audit(page, 'check this computer');
  await button(page, 'Continue').click();
  await audit(page, 'welcome, connected');
  await button(page, 'Start learning').click();
  await audit(page, 'goal');
  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await button(page, 'Start').click();
  await expect(heading(page, 'Researching React')).toBeVisible();
  await audit(page, 'research');
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
  await audit(page, 'roadmap');
  await button(page, 'Approve').click();
  const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
  await audit(page, 'setup consent');
  await consent.getByText('Details').click();
  await audit(page, 'setup consent, details');
  await consent.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(button(page, 'Read useState')).toBeVisible({ timeout: 15_000 });
  await audit(page, 'topic');
  await button(page, 'Read What javascript basics is').click();
  await audit(page, 'lesson');
  await button(page, 'Next').click();
  await button(page, 'Next').click();
  await expect(heading(page, 'Click Counter')).toBeVisible();
  await audit(page, 'activity');
  const results = page.getByRole('region', { name: 'Results' });
  await button(page, 'Check').click();
  await expect(results.getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
  await audit(page, 'results, not yet');
  await page.getByRole('textbox', { name: 'Counter.jsx' }).fill('// my answer');
  await button(page, 'Check').click();
  await expect(results.getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();
  await audit(page, 'results, passed');
  await button(page, 'Continue').click();
  await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible();
  await audit(page, 'course');
  await button(page, 'Tracks').click();
  await expect(heading(page, 'Tracks')).toBeVisible();
  await audit(page, 'tracks');
  await masterEverything(page);
  await button(page, 'Learn').click();
  await expect(heading(page, 'React complete')).toBeVisible();
  await audit(page, 'course complete');
  await app.close();
});

test('failure and environment screens pass WCAG AA checks', async () => {
  for (const scenario of ['no-agent', 'signed-out', 'untested-version']) {
    const { app, page } = await launch(scenario);
    await button(page, 'Connect an agent').click();
    await expect(page.getByRole('listitem', { name: 'Claude Code' })).toBeVisible();
    await audit(page, `connect, ${scenario}`);
    await app.close();
  }
  for (const scenario of ['no-docker', 'docker-stopped', 'docker-starting', 'windows-containers']) {
    const { app, page } = await launch(scenario);
    await connect(page);
    await expect(heading(page, 'Check this computer')).toBeVisible();
    await expect(page.getByRole('status')).not.toBeEmpty();
    await audit(page, `check this computer, ${scenario}`);
    await app.close();
  }
  for (const scenario of ['offline-setup', 'low-disk', 'setup-gates']) {
    const { app, page } = await launch(scenario);
    await toRoadmap(page);
    await button(page, 'Approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(page.getByRole('alert').or(page.getByRole('dialog'))).toBeVisible({ timeout: 15_000 });
    await audit(page, `setup, ${scenario}`);
    await app.close();
  }
  {
    const { app, page } = await launch('docker-stops');
    await toActivity(page);
    const results = page.getByRole('region', { name: 'Results' });
    await button(page, 'Check').click();
    await expect(results.getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Counter.jsx' }).fill('wrong');
    await button(page, 'Check').click();
    await expect(results.getByRole('heading', { name: "This check wasn't counted" })).toBeVisible();
    await audit(page, 'results, not counted');
    await app.close();
  }
  {
    const { app, page } = await launch();
    await toActivity(page);
    const results = page.getByRole('region', { name: 'Results' });
    await page.getByRole('textbox', { name: 'Counter.jsx' }).fill('wrong /* your code */');
    for (let i = 0; i < 3; i++) {
      await button(page, 'Check').click();
      await expect(results.getByRole('heading', { name: /passed|Try another way/ })).toBeVisible();
    }
    await expect(results.getByRole('heading', { name: 'Try another way' })).toBeVisible();
    await audit(page, 'results, stuck');
    await app.close();
  }
  {
    const { app, page } = await launch('plan-limit');
    await toActivity(page);
    await button(page, 'Hint').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await audit(page, 'plan limit');
    await app.close();
  }
});

const zoom = (app: ElectronApplication, factor: number) =>
  app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), factor);

test('the setup consent fits the window at 200% zoom, scrolls, and keeps its actions reachable', async () => {
  const { app, page } = await launch();
  await toRoadmap(page);
  await zoom(app, 2);
  await button(page, 'Approve').click();
  const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
  await consent.getByText('Details').click();
  const box = (await consent.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  // The last proposal file can be scrolled to, and the actions stay in view the whole time.
  const files = consent.getByRole('region');
  await files.last().scrollIntoViewIfNeeded();
  await expect(files.last()).toBeInViewport();
  await expect(consent.getByRole('button', { name: 'Set up', exact: true })).toBeInViewport();
  await expect(consent.getByRole('button', { name: 'Not now', exact: true })).toBeInViewport();
  await app.close();
});

test('the activity reflows at 200% zoom: editor, Check and Codemm stay usable', async () => {
  const { app, page } = await launch();
  await toRoadmap(page);
  await button(page, 'Approve').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await button(page, 'Read What javascript basics is').click();
  await button(page, 'Next').click();
  await button(page, 'Next').click();
  await expect(heading(page, 'Click Counter')).toBeVisible();
  await zoom(app, 2);
  const code = page.getByRole('textbox', { name: 'Counter.jsx' });
  await code.scrollIntoViewIfNeeded();
  expect((await code.boundingBox())!.width).toBeGreaterThan(200);
  await button(page, 'Check').click();
  const results = page.getByRole('region', { name: 'Results' });
  await results.scrollIntoViewIfNeeded();
  await expect(results.getByRole('heading', { name: '2 of 4 passed' })).toBeInViewport();
  const ask = page.getByRole('textbox', { name: 'Ask Codemm' });
  await ask.scrollIntoViewIfNeeded();
  await expect(ask).toBeInViewport();
  await zoom(app, 1);
  await app.close();
});

/** Presses Tab until the control named `name` has focus, then returns it. Fails if it never does. */
async function tabTo(page: Page, role: 'button' | 'textbox' | 'link', name: string) {
  const target = page.getByRole(role, { name, exact: true }).first();
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${role} "${name}"`);
}

async function press(page: Page, name: string) {
  await tabTo(page, 'button', name);
  await page.keyboard.press('Enter');
}

test('the journey works with the keyboard alone', async () => {
  const { app, page } = await launch();
  await press(page, 'Connect an agent');
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  await tabTo(page, 'button', 'Connect');
  await page.keyboard.press('Enter');
  await expect(claude.getByText('Connected')).toBeVisible();
  await press(page, 'Continue');
  await expect(page.getByText('This computer is ready.')).toBeVisible();
  await press(page, 'Continue');
  await press(page, 'Start learning');
  await tabTo(page, 'textbox', 'What do you want to learn?');
  await page.keyboard.type('React');
  await press(page, 'Start');
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
  await press(page, 'Approve');
  // The dialog moves focus to its first action; Set up is one Tab away.
  await press(page, 'Set up');
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await press(page, 'Read What javascript basics is');
  await press(page, 'Next');
  await press(page, 'Next');
  await expect(heading(page, 'Click Counter')).toBeVisible();
  await tabTo(page, 'textbox', 'Counter.jsx');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('// my answer');
  await press(page, 'Check');
  await expect(page.getByRole('region', { name: 'Results' }).getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();
  await app.close();
});

test('with reduced motion, nothing animates', async () => {
  const { app, page } = await launch();
  const moving = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
  expect(await moving()).toEqual([]);
  await toRoadmap(page);
  expect(await moving()).toEqual([]);
  await button(page, 'Approve').click();
  expect(await moving()).toEqual([]);
  await app.close();
});
