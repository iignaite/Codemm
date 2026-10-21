import AxeBuilder from '@axe-core/playwright';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect as baseExpect, test } from './launch';

// Screens change after IPC round trips to the app; slow CI runners need more than the default 5 s.
const expect = baseExpect.configure({ timeout: 15_000 });

// D16: WCAG AA on every screen, the journey by keyboard alone, and reduced motion.
// Runs the built app with the mock (CODEMM_MOCK), like smoke.spec.ts.

const AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Every test starts at 100% zoom, with reduced motion (launch.ts).
test.use({ settled: true });

/** Elements still animating or transitioning. With reduced motion there must be none. */
const moving = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
  );

/** Fails with every WCAG A and AA violation on the screen as it is now, or anything that moves under reduced motion. */
async function audit(page: Page, screen: string) {
  expect(await moving(page), `${screen}: animates under reduced motion`).toEqual([]);
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
      await call('check', id, 'e2e');
    }
  });
}

async function toActivity(page: Page, title = 'Click Counter') {
  await toRoadmap(page);
  await button(page, 'Approve').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
  // Set up runs once (useBusy): the dialog stays until the install starts, and it traps focus meanwhile.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await button(page, 'Read What javascript basics is').click();
  await button(page, 'Next').click();
  await button(page, 'Next').click();
  await expect(heading(page, title)).toBeVisible();
}

async function toRoadmap(page: Page) {
  await connect(page);
  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await button(page, 'Start').click();
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
}

test('every screen of the journey passes WCAG AA checks', async ({ launch }) => {
  const { app, page } = await launch();
  await audit(page, 'welcome');
  await button(page, 'Connect an agent').click();
  await audit(page, 'connect');
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('sonnet');
  await audit(page, 'connect, connected, with the model choice');
  // A computer that is ready at the first check passes by itself; its screens with a step are audited below.
  await button(page, 'Continue').click();
  await expect(heading(page, 'What do you want to learn?')).toBeVisible();
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
  await consent.getByText('Show the files').click();
  await audit(page, 'setup consent, details');
  // Not now: a lesson offers setup without blocking the reading.
  await consent.getByRole('button', { name: 'Not now', exact: true }).click();
  await button(page, 'Read What javascript basics is').click();
  await expect(button(page, 'Set up React')).toBeVisible();
  await audit(page, 'lesson, setup waiting');
  await button(page, 'Set up React').click();
  await consent.getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(consent).toBeHidden({ timeout: 15_000 });
  await button(page, 'Previous').click();
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
  // Continue goes straight on to the next topic.
  await button(page, 'Continue').click();
  await expect(heading(page, 'JSX')).toBeVisible();
  await button(page, 'Learn').click();
  await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible();
  await audit(page, 'course');
  await button(page, 'Tracks').click();
  await expect(heading(page, 'Tracks')).toBeVisible();
  await audit(page, 'tracks');
  await masterEverything(page);
  await button(page, 'Learn').click();
  await expect(heading(page, 'React complete')).toBeVisible();
  await audit(page, 'course complete');
  // A new goal's roadmap is a draft: the course stays, and the goal screen offers the draft again.
  await button(page, 'Learn something new').click();
  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('Vue');
  await button(page, 'Start').click();
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
  await button(page, 'Learn').click();
  await expect(heading(page, 'React complete')).toBeVisible();
  await button(page, 'Learn something new').click();
  await expect(button(page, 'Resume roadmap')).toBeVisible();
  await audit(page, 'goal, with a roadmap to resume');
  await button(page, 'Resume roadmap').click();
  await expect(heading(page, 'Vue')).toBeVisible();
  await app.close();
});

test('a relaunch with a connected agent opens on Welcome, connected, which passes WCAG AA checks', async ({ launch }) => {
  const { app, page } = await launch('relaunch');
  await expect(heading(page, 'Ready when you are.')).toBeVisible();
  await audit(page, 'welcome, connected');
  await app.close();
});

test('failure and environment screens pass WCAG AA checks', async ({ launch }) => {
  // Nine launches, each with a scan: on CI runners that's well past the default minute.
  test.setTimeout(240_000);
  for (const scenario of ['no-agent', 'untested-version']) {
    const { app, page } = await launch(scenario);
    await button(page, 'Connect an agent').click();
    await expect(page.getByRole('listitem', { name: 'Claude Code' })).toBeVisible();
    await audit(page, `connect, ${scenario}`);
    await app.close();
  }
  {
    // Install what's missing: before, during, and the agent's sign-in after Docker.
    const { app, page } = await launch('nothing-installed');
    await button(page, "Install what's missing").click();
    await expect(page.getByRole('listitem', { name: 'Docker Desktop' })).toBeVisible();
    await audit(page, 'setup, before installing');
    await button(page, "Install what's missing").click();
    await expect(page.getByRole('progressbar').first()).toBeVisible();
    await audit(page, 'setup, installing');
    await expect(button(page, 'Sign in')).toBeVisible();
    await audit(page, 'setup, sign in');
    await app.close();
  }
  {
    const { app, page } = await launch('agent-install-offline');
    await button(page, 'Connect an agent').click();
    const claude = page.getByRole('listitem', { name: 'Claude Code' });
    await claude.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(claude.getByRole('alert')).toHaveText("You're offline. Connect to the internet, then try again.");
    await audit(page, 'connect, agent install failed');
    await app.close();
  }
  {
    const { app, page } = await launch('signed-out');
    await button(page, 'Connect an agent').click();
    const claude = page.getByRole('listitem', { name: 'Claude Code' });
    await claude.getByRole('button', { name: 'Connect' }).click();
    await expect(claude.getByText('Sign in to Claude Code, then try again.')).toBeVisible();
    await audit(page, 'connect, signed out');
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
  for (const [scenario, title] of [['offline-setup', "You're offline."], ['low-disk', 'Not enough disk space.'], ['setup-gates', "Couldn't set up React."]]) {
    const { app, page } = await launch(scenario);
    await toRoadmap(page);
    await button(page, 'Approve').click();
    const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
    await consent.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(consent).toBeHidden({ timeout: 15_000 });
    await expect(heading(page, title)).toBeVisible({ timeout: 15_000 });
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
      await expect(results.getByRole('heading', { name: /passed|Try another way/ }).first()).toBeVisible();
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

test('the setup consent fits the window at 200% zoom, scrolls, and keeps its actions reachable', async ({ launch }) => {
  const { app, page } = await launch();
  await toRoadmap(page);
  await zoom(app, 2);
  await button(page, 'Approve').click();
  const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
  await consent.getByText('Show the files').click();
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

test('the activity reflows at 200% zoom: editor, Check and Codemm stay usable', async ({ launch }) => {
  const { app, page } = await launch();
  await toRoadmap(page);
  await button(page, 'Approve').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
  // Set up runs once (useBusy): the dialog stays until the install starts, and it traps focus meanwhile.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
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

/**
 * What sticks out past the window's sides, or text that spills out of its own box, named by tag and class: nothing
 * should, so the screen reflows (WCAG 1.4.10). Code is exempt: it keeps its lines and scrolls inside its own box.
 */
const overflowing = (page: Page) =>
  page.evaluate(() => {
    const wide = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter((el) => !el.closest('.code, pre, .xterm, [aria-hidden="true"]'))
      .filter((el) => {
        // Cut off or scrolled sideways, it's out of reach either way, so a clipping ancestor doesn't excuse it.
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.right > wide + 1 || r.left < -1) return true;
        // Text that spills out of its own box paints over its neighbors.
        const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        return text && getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : ''}`)
      .slice(0, 5);
  });

const size = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);

/** Checks a screen in the smallest window (800 by 600), and at 200% and 400% zoom: about 640 and 320 CSS pixels wide. */
async function reflows(app: ElectronApplication, page: Page, screen: string) {
  await size(app, 800, 600);
  await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(800);
  baseExpect.soft(await overflowing(page), `${screen} at 800 by 600`).toEqual([]);
  await size(app, 1280, 800);
  for (const factor of [2, 4]) {
    await zoom(app, factor);
    await page.waitForTimeout(150);
    baseExpect.soft(await overflowing(page), `${screen} at ${factor * 100}%`).toEqual([]);
    // Every way out stays reachable: the sidebar scrolls when the window is short.
    for (const item of await page.getByRole('navigation', { name: 'Main' }).getByRole('button').all()) {
      await item.scrollIntoViewIfNeeded();
      await baseExpect.soft(item, `${screen} at ${factor * 100}%: ${await item.getAttribute('aria-label') ?? await item.textContent()}`).toBeInViewport({ ratio: 1 });
    }
  }
  await zoom(app, 1);
}

test('every screen reflows in the smallest window and at 200% and 400% zoom: nothing sticks out past it', async ({ launch }) => {
  test.setTimeout(120_000);
  const { app, page } = await launch();
  await expect(button(page, 'Connect an agent')).toBeVisible();
  // The check itself: something too wide is caught.
  // Styled through the DOM: the window's content security policy drops inline style attributes.
  await page.evaluate(() => {
    const wide = Object.assign(document.createElement('div'), { id: 'too-wide' });
    Object.assign(wide.style, { position: 'absolute', top: '0', left: '0', width: '3000px', height: '10px' });
    document.body.append(wide);
  });
  baseExpect(await overflowing(page)).toContain('div');
  await page.evaluate(() => document.getElementById('too-wide')!.remove());
  await reflows(app, page, 'welcome');
  await button(page, 'Connect an agent').click();
  await expect(heading(page, 'Connect an agent')).toBeVisible();
  await reflows(app, page, 'connect');
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button(page, 'Continue').click();
  await expect(page.getByRole('textbox', { name: 'What do you want to learn?' })).toBeVisible();
  await reflows(app, page, 'goal');
  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await button(page, 'Start').click();
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });
  await reflows(app, page, 'roadmap');
  await button(page, 'Approve').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Set up', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await reflows(app, page, 'topic');
  await button(page, 'Read What javascript basics is').click();
  await expect(button(page, 'Next')).toBeVisible();
  await reflows(app, page, 'lesson');
  await button(page, 'Next').click();
  await button(page, 'Next').click();
  await expect(heading(page, 'Click Counter')).toBeVisible();
  await reflows(app, page, 'activity');
  await button(page, 'Check').click();
  await expect(page.getByRole('region', { name: 'Results' }).getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
  await reflows(app, page, 'results');
  await button(page, 'Learn').click();
  await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible({ timeout: 15_000 });
  await reflows(app, page, 'course map');
  await button(page, 'Tracks').click();
  await expect(heading(page, 'Tracks')).toBeVisible();
  await reflows(app, page, 'tracks');
  await masterEverything(page);
  await button(page, 'Learn').click();
  await expect(heading(page, 'React complete')).toBeVisible();
  await reflows(app, page, 'course complete');
  await app.close();
});

test('at 1280 px and narrower, the side columns narrow so the editor keeps its room', async ({ launch }) => {
  const { app, page } = await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
  await toActivity(page);
  const statement = await page.locator('.stmt').boundingBox();
  const codemm = await page.getByRole('complementary', { name: 'Codemm' }).boundingBox();
  expect(statement!.width).toBeLessThanOrEqual(281);
  expect(codemm!.width).toBeLessThanOrEqual(281);
  await app.close();
});

/** Elements Tab can stop on right now. */
const focusables = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
        (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.checkVisibility(),
      ).length,
  );

/**
 * Presses Tab until the control named `name` has focus. It waits for the control first, so a screen still loading
 * (the agent list, a lesson) is never tabbed through early. Then one lap through every focusable element, plus the
 * stop on the page itself, must reach it, or it fails. The lap is counted again before each press: a screen that
 * was still swapping in when the count began (the next lesson after Next) has more controls once it's there.
 */
async function tabTo(page: Page, role: 'button' | 'textbox' | 'menuitem' | 'combobox', name: string | RegExp) {
  const target = page.getByRole(role, { name, exact: typeof name === 'string' }).first();
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  let presses = 0;
  while (!(await target.evaluate((el) => el === document.activeElement))) {
    if (presses >= (await focusables(page)) + 2) {
      throw new Error(`Tab never reached ${role} "${name}" in ${presses} presses on:\n${await page.locator('body').ariaSnapshot()}`);
    }
    await page.keyboard.press('Tab');
    presses++;
  }
}

async function press(page: Page, name: string | RegExp) {
  await tabTo(page, 'button', name);
  await page.keyboard.press('Enter');
}

async function typeInto(page: Page, name: string, text: string) {
  await tabTo(page, 'textbox', name);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

test('the journey works with the keyboard alone', async ({ launch }) => {
  // Every Tab is a round trip to the app; on CI runners the whole walk takes far longer than locally.
  test.setTimeout(240_000);
  const { app, page } = await launch();
  await press(page, 'Connect an agent');
  await press(page, 'Connect');
  await expect(page.getByRole('listitem', { name: 'Claude Code' }).getByText('Connected')).toBeVisible();
  // The model choice is reachable by keyboard.
  await tabTo(page, 'combobox', 'Model');
  await press(page, 'Continue');
  await expect(heading(page, 'What do you want to learn?')).toBeVisible();
  await typeInto(page, 'What do you want to learn?', 'React');
  await press(page, 'Start');
  await expect(button(page, 'Approve')).toBeVisible({ timeout: 15_000 });

  await test.step('edit the roadmap: rename the last topic, then move it with the Move menu', async () => {
  const topics = page.getByRole('list').last().getByRole('listitem');
  const last = (await topics.last().getAttribute('aria-label'))!;
  await press(page, `Rename ${last}`);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Testing basics');
  await page.keyboard.press('Enter');
  await expect(topics.last()).toHaveAttribute('aria-label', 'Testing basics');
  await press(page, 'Move Testing basics');
  await expect(page.getByRole('menu', { name: 'Move Testing basics' })).toBeVisible();
  await tabTo(page, 'menuitem', 'Move up');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeHidden();
  });

  await press(page, 'Approve');
  await press(page, 'Set up');
  // Set up runs once (useBusy): the dialog stays until the install starts, and it traps focus meanwhile.
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  await expect(button(page, 'Read What javascript basics is')).toBeVisible({ timeout: 15_000 });
  await press(page, 'Read What javascript basics is');

  await test.step('add a lesson note', async () => {
  await press(page, 'Add a note');
  await page.keyboard.type('The setter replaces the value.');
  await press(page, 'Save');
  await expect(page.getByText('The setter replaces the value.')).toBeVisible();
  });
  await press(page, 'Next');
  await press(page, 'Next');
  await expect(heading(page, 'Click Counter')).toBeVisible();

  const results = page.getByRole('region', { name: 'Results' });
  await test.step('fail a check until stuck, then skip to the course view', async () => {
  await typeInto(page, 'Counter.jsx', 'wrong /* your code */');
  for (let i = 0; i < 3; i++) {
    await press(page, 'Check');
    await expect(results.getByRole('heading', { name: /passed|Try another way/ }).first()).toBeVisible();
  }
  await press(page, 'Come back later');
  await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible();
  });

  await test.step('the next topic, through to a passing check', async () => {
  await press(page, 'Continue');
  await press(page, /^Read /);
  // Next through the topic's lessons until the activity; each step waits for the screen to change.
  const title = page.getByRole('heading', { level: 1 }).first();
  for (let i = 0; i < 6 && (await title.textContent()) !== 'Click Counter'; i++) {
    const before = (await title.textContent())!;
    await press(page, 'Next');
    await expect(title).not.toHaveText(before);
  }
  await expect(heading(page, 'Click Counter')).toBeVisible();
  await typeInto(page, 'Counter.jsx', '// my answer');
  await press(page, 'Check');
  await expect(results.getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();
  // Straight on to the next topic: the roadmap edit above put Forms before Lists and keys.
  await press(page, 'Continue');
  await expect(heading(page, 'Lists and keys')).toBeVisible();
  });
  await app.close();
});

// Run (§4.10): the terminal pane passes WCAG AA while a program runs and after Try it, and works by keyboard.
// The program gets the full 2 minutes, so the scans never race its time limit.
test('the terminal pane passes WCAG AA checks and works with the keyboard alone', async ({ launch }) => {
  test.setTimeout(120_000);
  const { app, page } = await launch('io-track');
  await toActivity(page, 'Greet by name');
  const log = page.getByRole('log', { name: 'Terminal for Greet by name, as text' });
  await press(page, 'Run');
  await expect(log).toHaveText(/What's your name\? $/);
  // Focus moves into the pane, so typing goes to the program.
  await expect(page.getByRole('textbox', { name: 'Terminal for Greet by name input' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Terminal for Greet by name' })).toContainText('left');
  await audit(page, 'terminal, running');
  await page.screenshot({ path: process.env.CODEMM_SCREENSHOT ?? test.info().outputPath('terminal.png') });
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect(log).toContainText('Hello, Ada!');
  await expect(log).toContainText('The program ended.');

  // Try it shows its results in Results alone; the pane keeps the Run.
  await press(page, 'Try it');
  await expect(page.getByRole('region', { name: 'Results' }).getByRole('heading', { name: '0 of 2 visible tests passed' })).toBeVisible();
  await expect(log).not.toContainText('(test 02)');
  await audit(page, 'terminal and Results, Try it');
  await app.close();
});

// The time limit: the pane and its header say the time is up, and pass WCAG AA.
test('the terminal pane says when the time is up', async ({ launch }) => {
  test.setTimeout(120_000);
  const { app, page } = await launch('run-time-up');
  await toActivity(page, 'Greet by name');
  const log = page.getByRole('log', { name: 'Terminal for Greet by name, as text' });
  await press(page, 'Run');
  await expect(log).toContainText("Time's up. The program was stopped after 3 seconds.", { timeout: 10_000 });
  await expect(page.getByRole('region', { name: 'Terminal for Greet by name' })).toContainText("Time's up");
  await audit(page, 'terminal, time up');
  await app.close();
});
