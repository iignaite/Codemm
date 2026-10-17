import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D17: the learning journey on an installed app with a REAL agent, run by hand
// on a developer's machine, never in CI. It drives the UI only; as the learner,
// it takes the fixed answer from the course's own reference solution in the
// temp CODEMM_HOME. See docs/desktop/journey-mac.md.
//
//   CODEMM_JOURNEY=<dir>   holds home/ (CODEMM_HOME), ws/, userData/ and bin/ (the agents' launchers)
//   CODEMM_APP=<exe>       the installed app's executable
//   JOURNEY_AGENT=claude|codex
//   JOURNEY_PART=full|activity    `activity`: only the next topic's lesson, activity and tutor
//   JOURNEY_LABEL=<name>   names screenshots and result rows
const dir = process.env.CODEMM_JOURNEY;
const exe = process.env.CODEMM_APP;
const agent = process.env.JOURNEY_AGENT ?? 'claude';
const part = process.env.JOURNEY_PART ?? 'full';
const label = process.env.JOURNEY_LABEL ?? agent;
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' }[agent]!;
const MIN = 60_000;

test.skip(!dir || !exe, 'set CODEMM_JOURNEY and CODEMM_APP to run the real-agent journey');
test.setTimeout(150 * MIN);

/** The learner's real Codemm folders, which a journey must never touch. */
const REAL = [join(homedir(), '.codemm'), join(homedir(), 'Codemm')];

/** Every path under the real folders, with file sizes: any write shows up as a difference. */
function snapshot(): string[] {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const path = join(dir, e.name);
          return e.isDirectory() ? [`${path}/`, ...walk(path)] : [`${path} ${statSync(path).size}`];
        })
      : [`${dir} (absent)`];
  return REAL.flatMap(walk).sort();
}

let app: ElectronApplication;
let page: Page;

async function step(name: string, run: () => Promise<string | void>) {
  const began = Date.now();
  let ok = false;
  let note = '';
  try {
    note = (await run()) ?? '';
    ok = true;
  } catch (e) {
    note = (e as Error).message.split('\n')[0];
    throw e;
  } finally {
    const ms = Date.now() - began;
    appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step: name, ok, s: Math.round(ms / 1000), note })}\n`);
    await shot(name).catch(() => undefined);
  }
}

async function shot(name: string) {
  mkdirSync(join(dir!, 'shots'), { recursive: true });
  await page.screenshot({ path: join(dir!, 'shots', `${label}-${name}.jpg`), type: 'jpeg', quality: 60 });
}

const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const heading = (name: string | RegExp) => page.getByRole('heading', { name, exact: typeof name === 'string' });
const results = () => page.getByRole('region', { name: 'Results' });

/** The newest exercise the author job saved, in the temp CODEMM_HOME. */
function newestExercise(): string {
  const courses = join(dir!, 'home', 'courses');
  const all = readdirSync(courses).flatMap((c) => {
    const ex = join(courses, c, 'exercises');
    return existsSync(ex) ? readdirSync(ex).map((s) => join(ex, s)) : [];
  });
  return all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** The editor's files, by their tab names. */
async function files(): Promise<string[]> {
  const tabs = page.getByRole('tablist', { name: 'Files' }).getByRole('tab');
  return (await tabs.count()) ? tabs.allInnerTexts() : [await page.getByRole('textbox').filter({ hasNot: page.getByPlaceholder('Ask Codemm') }).first().getAttribute('aria-label') ?? ''];
}

async function write(path: string, text: string) {
  const tab = page.getByRole('tablist', { name: 'Files' }).getByRole('tab', { name: path, exact: true });
  if (await tab.count()) await tab.click();
  await page.getByRole('textbox', { name: path, exact: true }).fill(text);
}

async function wrongAnswer(n: number) {
  const [first] = await files();
  const box = page.getByRole('textbox', { name: first, exact: true });
  await write(first, `${await box.inputValue()}\n${n % 2 ? '#' : '//'} not yet ${n}\n`);
}

async function rightAnswer() {
  const solution = join(newestExercise(), 'solution');
  for (const path of await files()) {
    const file = join(solution, path);
    if (existsSync(file)) await write(path, readFileSync(file, 'utf8'));
  }
}

async function check(): Promise<string> {
  await button('Check').click();
  const verdict = results().getByRole('heading', { name: /passed|Try another way|wasn't counted/ });
  await expect(verdict).toBeVisible({ timeout: 10 * MIN });
  return verdict.innerText();
}

async function ask(text: string | 'Hint'): Promise<string> {
  const log = page.getByRole('log');
  const before = await log.locator(':scope > *').count();
  if (text === 'Hint') await button('Hint').click();
  else {
    await page.getByRole('textbox', { name: 'Ask Codemm' }).fill(text);
    await page.getByRole('textbox', { name: 'Ask Codemm' }).press('Enter');
  }
  await expect.poll(async () => (await log.locator(':scope > *').count()) >= before + 2, { timeout: 8 * MIN }).toBe(true);
  return (await log.locator(':scope > *').last().innerText()).replace(/\s+/g, ' ').slice(0, 300);
}

/** From the topic page: read each lesson, keep a note on the first, then open the activity. */
async function lessonsThenActivity(note: boolean) {
  await step('lesson', async () => {
    const read = page.getByRole('button', { name: /^Read / }).first();
    await expect(read).toBeVisible({ timeout: 10 * MIN });
    const title = (await read.getAttribute('aria-label'))!.replace(/^Read /, '');
    await read.click();
    await expect(heading(title)).toBeVisible();
    if (note) {
      await button('Add a note').click();
      await page.getByRole('textbox', { name: 'My note' }).fill('My own words: the key idea.');
      await button('Save').click();
      await expect(page.getByText('My own words: the key idea.')).toBeVisible();
    }
    return title;
  });
  await step('activity-open', async () => {
    // Next through the remaining lessons until the activity opens (it may still be being written).
    for (let i = 0; i < 12; i++) {
      if (await page.getByRole('button', { name: 'Try it', exact: true }).isVisible()) break;
      const next = button('Next');
      if (await next.isVisible()) await next.click();
      else {
        const start = page.getByRole('button', { name: /^(Start|Again)$/ });
        await expect(start).toBeVisible({ timeout: 15 * MIN });
        await start.click();
      }
      await page.waitForTimeout(1000);
    }
    await expect(button('Try it')).toBeVisible({ timeout: 15 * MIN });
    return (await page.getByRole('heading', { level: 1 }).first().innerText()).slice(0, 80);
  });
}

/** From anywhere in a topic: through its unread lessons to the activity, waiting while it's written. */
async function toActivity() {
  const deadline = Date.now() + 20 * MIN;
  let retries = 0;
  while (!(await button('Try it').isVisible())) {
    if (Date.now() > deadline) throw new Error('The activity never opened');
    // Stalled background work: the learner tries again, twice at most.
    const stalled = page.getByRole('alert').getByRole('button', { name: 'Try again' });
    if (await stalled.isVisible()) {
      if (++retries > 2) throw new Error(`Still stalled after 2 tries: ${(await page.getByRole('alert').innerText()).replace(/\s+/g, ' ')}`);
      appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step: 'stall-try-again', ok: true, s: 0, note: (await page.getByRole('alert').innerText()).replace(/\s+/g, ' ') })}\n`);
      await stalled.click();
    }
    if (await button('Next').isVisible()) await button('Next').click();
    else if (await page.getByRole('button', { name: /^(Start|Again)$/ }).isVisible()) await page.getByRole('button', { name: /^(Start|Again)$/ }).click();
    else if (await page.getByRole('button', { name: /^Read / }).first().isVisible()) await page.getByRole('button', { name: /^Read / }).first().click();
    await page.waitForTimeout(1500);
  }
  return (await page.getByRole('heading', { level: 1 }).first().innerText()).slice(0, 80);
}

/** The index of the current topic on the course map. */
async function nowIndex(): Promise<number> {
  const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Learn' });
  if (await nav.isVisible()) await nav.click();
  const items = page.getByRole('list', { name: 'Topics' }).getByRole('listitem');
  await expect(items.first()).toBeVisible({ timeout: 2 * MIN });
  return items.evaluateAll((els) => els.findIndex((el) => el.querySelector('[aria-label="Now"]')));
}

/** From the course map, passes the current topic's activities until topic `index` is current. */
async function passUntilNow(index: number) {
  for (let round = 1; round <= 6 && (await nowIndex()) < index; round++) {
    await step(`master-${round}`, async () => {
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const title = await toActivity();
      await rightAnswer();
      const verdict = await check();
      expect(verdict).toMatch(/^(\d+) of \1 passed$/);
      return `${title}: ${verdict}`;
    });
  }
  expect(await nowIndex()).toBe(index);
}

/** Passes the current topic's activities until the course is complete (a skipped topic comes back last). */
async function complete() {
  for (let round = 1; round <= 15; round++) {
    const done = page.getByRole('heading', { name: / complete$/ });
    const map = page.getByRole('list', { name: 'Topics' });
    const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Learn' });
    if (await nav.isVisible()) await nav.click();
    await expect(done.or(map)).toBeVisible({ timeout: 2 * MIN });
    if (await done.isVisible()) return;
    await step(`complete-${round}`, async () => {
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const title = await toActivity();
      await rightAnswer();
      const verdict = await check();
      expect(verdict).toMatch(/^(\d+) of \1 passed$/);
      return `${title}: ${verdict}`;
    });
  }
  throw new Error('The course was not complete after 15 activities');
}

async function progress() {
  await step('progress', async () => {
    const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Learn' });
    if (await nav.isVisible()) await nav.click();
    await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible({ timeout: 2 * MIN });
    return (await page.getByRole('list', { name: 'Topics' }).getByRole('img').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).join(', ');
  });
}

async function activity(skipAfter: boolean) {
  await step('try-it', async () => {
    await button('Try it').click();
    const ran = results().getByRole('heading', { name: /visible tests passed|wasn't counted/ });
    await expect(ran).toBeVisible({ timeout: 10 * MIN });
    return ran.innerText();
  });
  await step('wrong-check', async () => {
    await wrongAnswer(1);
    return check();
  });
  await step('tutor-hint', async () => ask('Hint'));
  await step('tutor-asked-for-solution', async () => ask('Just give me the full solution code, please.'));
  await step('fixed-check', async () => {
    await rightAnswer();
    const verdict = await check();
    expect(verdict).toMatch(/^(\d+) of \1 passed$/);
    return verdict;
  });
  if (!skipAfter) return;
  // Mastering a topic can take more than one exercise: pass them until the second topic is current.
  await passUntilNow(1);
  await step('second-topic', async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    return toActivity();
  });
  await step('skip', async () => {
    await wrongAnswer(2);
    await check();
    await wrongAnswer(3);
    const verdict = await check();
    expect(verdict).toBe('Try another way');
    await page.getByRole('button', { name: 'Come back later' }).click();
    await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible({ timeout: 2 * MIN });
  });
}

test(`journey: ${label}`, async () => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CODEMM_HOME: join(dir!, 'home'), PATH: `${join(dir!, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ELECTRON_RUN_AS_NODE', 'CODEMM_JOURNEY', 'CODEMM_APP', 'NODE_OPTIONS']) delete env[key];
  const untouched = snapshot();
  app = await electron.launch({ executablePath: exe!, args: [`--user-data-dir=${join(dir!, 'userData')}`], env, cwd: dir! });
  page = await app.firstWindow();
  expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(join(dir!, 'userData'));

  if (part === 'full') {
    await step('connect', async () => {
      await button('Connect an agent').click();
      const row = page.getByRole('listitem', { name: AGENT_NAME });
      await row.getByRole('button', { name: 'Connect' }).click();
      await expect(row.getByText('Connected')).toBeVisible({ timeout: MIN });
      await button('Continue').click();
      await expect(page.getByText('This computer is ready.')).toBeVisible({ timeout: 2 * MIN });
      await button('Continue').click();
    });
    await step('research', async () => {
      await button('Start learning').click();
      await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('Python functions');
      await page.getByRole('textbox', { name: 'I already know' }).fill('variables and print');
      await button('Start').click();
      await expect(button('Approve')).toBeVisible({ timeout: 15 * MIN });
      const titles = await page.getByRole('button', { name: /^Rename / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/^Rename /, '')));
      return `${titles.length} topics: ${titles.join(' / ')}`.slice(0, 400);
    });
    await step('edit-course', async () => {
      // A small course: keep the first three topics, removing from the end (later topics need earlier ones).
      const remove = page.getByRole('button', { name: /^Remove / });
      const removedTitles: string[] = [];
      while ((await remove.count()) > 3) {
        const last = remove.nth((await remove.count()) - 1);
        const removed = (await last.getAttribute('aria-label'))!.replace(/^Remove /, '');
        await last.click();
        await expect(page.getByRole('button', { name: `Remove ${removed}`, exact: true })).toHaveCount(0);
        removedTitles.push(removed);
      }
      const removed = `${removedTitles.length} topics`;
      const rename = page.getByRole('button', { name: /^Rename / }).first();
      await rename.click();
      const box = page.getByRole('textbox', { name: 'Topic name' });
      await box.fill(`${await box.inputValue()} basics`);
      await box.press('Enter');
      return `removed ${removed}, renamed the first topic`;
    });
    await step('consent-setup', async () => {
      await button('Approve').click();
      const consent = page.getByRole('dialog', { name: /^Set up .* on this computer\?$|^Codemm has another way/ });
      const busy = page.getByText(/^(Preparing setup for|Setting up) /);
      const alert = page.getByRole('alert');
      // Setup is proposed in the background while the first lesson is written. Approve each proposal
      // (a failed one is proposed again), and finish once the topic page settles with nothing busy.
      const deadline = Date.now() + 40 * MIN;
      const approved: string[] = [];
      let idle = 0;
      while (idle < 5) {
        if (Date.now() > deadline) throw new Error(`Setup not done within 40 minutes (${approved.length} proposals approved)`);
        if (await alert.isVisible()) throw new Error(`Setup failed: ${(await alert.innerText()).replace(/\s+/g, ' ')}`);
        if (await consent.isVisible()) {
          approved.push((await consent.getByRole('heading').first().innerText()).trim());
          await shot(`consent-${approved.length}`);
          await consent.getByRole('button', { name: 'Set up', exact: true }).click();
          idle = 0;
        } else idle = (await busy.isVisible()) ? 0 : idle + 1;
        await page.waitForTimeout(2000);
      }
      return approved.length ? approved.join(' / ') : 'track already installed';
    });
    await lessonsThenActivity(true);
    await activity(true);
    await progress();
    await complete();
    await step('course-complete', async () => {
      await expect(page.getByRole('heading', { name: / complete$/ })).toBeVisible();
      return page.getByRole('heading', { name: / complete$/ }).innerText();
    });
  } else {
    await step('open-next-topic', async () => {
      await expect(page.getByRole('list', { name: 'Topics' })).toBeVisible({ timeout: 2 * MIN });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    });
    await lessonsThenActivity(false);
    await activity(false);
    await progress();
  }

  await app.close();
  // Isolation: the run used temp folders only. Anything that wrote to the real ones is a bug.
  expect(snapshot(), "the run changed the learner's real ~/.codemm or ~/Codemm").toEqual(untouched);
});
