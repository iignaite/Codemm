import { _electron as electron, expect, test } from '@playwright/test';

// Launches the built app (with the mock core) and walks the main journey.
test('connect, goal, course, lesson and practice', async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });

  await button('Connect an agent').click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button('Continue').click();
  await button('Start learning').click();

  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await page.getByRole('group', { name: 'I already know' }).getByRole('button', { name: 'Python' }).click();
  await button('Start').click();
  await expect(heading('Researching React')).toBeVisible();

  await expect(heading('React basics')).toBeVisible({ timeout: 15_000 });
  await button('Approve').click();
  await page.getByRole('dialog', { name: 'Set up React on this computer?' }).getByRole('button', { name: 'Set up' }).click();

  await expect(heading('JavaScript basics')).toBeVisible();
  await expect(button('Read useState')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Setting up React')).toBeHidden({ timeout: 15_000 });
  await button('Read What javascript basics is').click();
  await button('Next').click();
  await expect(heading('useState')).toBeVisible();
  await page.getByRole('group', { name: 'Your answer' }).getByRole('button', { name: 'Count: 2' }).click();
  await button('Next').click();

  await expect(heading('Click Counter')).toBeVisible();
  const results = page.getByRole('region', { name: 'Results' });
  await button('Check').click();
  await expect(results.getByRole('heading', { name: '2 of 4 passed' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Counter.jsx' }).fill('// my answer');
  await button('Check').click();
  await expect(results.getByRole('heading', { name: '4 of 4 passed' })).toBeVisible();

  await app.close();
});
