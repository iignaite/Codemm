import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test('walks connect, goal, course, lesson and practice on the mock', async () => {
  const app = await electron.launch({ args: [join(__dirname, '..')] });
  const page = await app.firstWindow();
  // Reduced motion: checks that path, and keeps screenshots settled.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await expect(page.getByRole('heading', { name: 'Learn anything.' })).toBeVisible();
  await shot(page, '01-welcome');
  await page.getByRole('button', { name: 'Connect an agent' }).click();
  await page.getByRole('button', { name: 'Connect Claude Code' }).click();
  await expect(page.getByText('Connected')).toBeVisible();
  await shot(page, '02-connect');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await shot(page, '03-ready');
  await page.getByRole('button', { name: 'Start learning' }).click();

  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await page.getByRole('button', { name: 'Python' }).click();
  await expect(page.getByText("React isn't set up yet.")).toBeVisible();
  await shot(page, '04-goal');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('You know Python')).toBeVisible();
  await shot(page, '05-research');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Move Components', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await shot(page, '06-course');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('dialog', { name: 'Set up React on this computer?' })).toBeVisible();
  await shot(page, '07-setup');
  await page.getByRole('button', { name: 'Set up' }).click();

  await expect(page.getByRole('heading', { name: 'JavaScript basics' })).toBeVisible();
  await shot(page, '08-topic');
  await page.getByRole('button', { name: 'Read Values and variables' }).click();
  await expect(page.getByRole('heading', { name: 'Values and variables' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Count: 2' }).click();
  await expect(page.getByRole('status')).toContainText('Count: 2');
  await shot(page, '09-lesson');
  await expect(page.getByRole('button', { name: 'Activity' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Click Counter' })).toBeVisible();
  await shot(page, '10-practice');
  await page.getByRole('textbox', { name: 'Counter.jsx' }).press('End');
  await page.getByRole('textbox', { name: 'Counter.jsx' }).pressSequentially(' ');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
  await shot(page, '11-not-yet');
  await page.getByRole('switch', { name: 'Assist' }).click();
  await expect(page.getByRole('dialog', { name: 'Let Codemm edit this activity?' })).toBeVisible();
  await shot(page, '12-assist');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();
  await shot(page, '13-passed');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'React basics' })).toBeVisible();
  await shot(page, '14-course-map');
  await page.getByRole('button', { name: 'Tracks' }).click();
  await expect(page.getByRole('button', { name: 'Rebuild React' })).toBeVisible();
  await shot(page, '15-tracks');

  await app.close();
});
