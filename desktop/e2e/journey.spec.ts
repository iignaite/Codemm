import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D17: the learning journey on an installed app with REAL agents, run by hand on a
// developer's machine, never in CI. It drives the UI only. As the learner, it takes the
// fixed answer from the course's own reference solution in the temp CODEMM_HOME. Every
// screen and every waiting state is screenshotted, and every step is timed. Evidence:
// docs/desktop/journey-mac.md.
//
//   CODEMM_JOURNEY=<dir>    the run's own folders: home/ (CODEMM_HOME), ws/ (workspace),
//                           userData/ (Electron profile and logs), bin/ (the agents' launchers)
//   CODEMM_APP=<exe>        the installed app's executable
//   JOURNEY_AGENT=claude|codex, JOURNEY_MODEL=<model id, chosen in the connect screen's Model select>,
//   JOURNEY_LABEL=<name>
//   JOURNEY_TOPIC=<goal>    what to learn (default "Python functions"); JOURNEY_KNOWN=<what's known>
//   JOURNEY_PART=full|setup|activity|no-agent|no-docker|docker-stop|docker-setup|low-disk|offline-setup|fake-research|fakes
//                           (`fakes` runs on a set-up course with e2e/fake-claude.cjs as Claude Code)
//   JOURNEY_FLOW=<comma list> extras for `full`: edits, reopen, show-me, stuck, pages, relaunch,
//                           relaunch-setup, switch=<agent>, new-course
const dir = process.env.CODEMM_JOURNEY;
const exe = process.env.CODEMM_APP;
const agent = process.env.JOURNEY_AGENT ?? 'claude';
const part = process.env.JOURNEY_PART ?? 'full';
const model = process.env.JOURNEY_MODEL;
const label = process.env.JOURNEY_LABEL ?? agent;
const topic = process.env.JOURNEY_TOPIC ?? 'Python functions';
const known = process.env.JOURNEY_KNOWN ?? 'variables and print';
const flow = new Set((process.env.JOURNEY_FLOW ?? '').split(',').filter(Boolean));
const switchTo = [...flow].find((f) => f.startsWith('switch='))?.slice('switch='.length);
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const MIN = 60_000;

test.skip(!dir || !exe, 'set CODEMM_JOURNEY and CODEMM_APP to run the real-agent journey');
test.setTimeout(240 * MIN);

// ---------- isolation ----------

/** The learner's real Codemm folders, which a journey must never touch. */
const REAL_DATA = [join(homedir(), '.codemm'), join(homedir(), 'Codemm')];
const REAL_PROFILE = join(homedir(), 'Library', 'Application Support', 'Codemm', 'desktop.json');
const REAL_LOG = join(homedir(), 'Library', 'Logs', 'Codemm', 'codemm.log');

/**
 * What a run must leave unchanged: every path and size under the real data folders, the real
 * desktop.json, and how many packaged-app starts the real log holds. (Development runs of other
 * work share that log, so its size can change; a packaged start in it would be this run's.)
 */
function snapshot() {
  const walk = (folder: string): string[] =>
    existsSync(folder)
      ? readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
          const path = join(folder, e.name);
          return e.isDirectory() ? [`${path}/`, ...walk(path)] : [`${path} ${statSync(path).size}`];
        })
      : [`${folder} (absent)`];
  const hash = (file: string) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent');
  const packagedStarts = existsSync(REAL_LOG) ? (readFileSync(REAL_LOG, 'utf8').match(/ start .*packaged=true/g) ?? []).length : 0;
  return { data: REAL_DATA.flatMap(walk).sort(), profile: hash(REAL_PROFILE), packagedStarts };
}

// ---------- evidence ----------

let app: ElectronApplication;
let page: Page;
const seen = new Set<string>();

async function step(name: string, run: () => Promise<string | void>) {
  const began = Date.now();
  let ok = false;
  let note = '';
  try {
    note = (await run()) ?? '';
    ok = true;
  } catch (e) {
    note = (e as Error).message.split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '');
    throw e;
  } finally {
    appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step: name, ok, s: Math.round((Date.now() - began) / 1000), note })}\n`);
    await shot(name).catch(() => undefined);
  }
}

async function shot(name: string) {
  mkdirSync(join(dir!, 'shots'), { recursive: true });
  await page.screenshot({ path: join(dir!, 'shots', `${label}-${name}.jpg`), type: 'jpeg', quality: 60 });
}

/** Screenshots a waiting state the first time it shows. */
async function waiting(name: string, locator: Locator) {
  if (seen.has(name) || !(await locator.first().isVisible().catch(() => false))) return;
  seen.add(name);
  await shot(`waiting-${name}`);
}

/** Every waiting state the app shows, checked while the driver waits. */
async function waitingStates() {
  await waiting('research', page.getByRole('heading', { name: /^Researching / }));
  await waiting('preparing-setup', page.getByText(/^Preparing setup for /));
  await waiting('setting-up', page.getByText(/^Setting up /));
  await waiting('writing-lesson', page.getByRole('img', { name: 'Writing' }));
  await waiting('writing-activity', page.getByRole('img', { name: /Writing the activity|Being written/ }));
  await waiting('checking', page.getByText(/^(Checking|Running)/));
  await waiting('tutor-answering', page.locator('[role="log"][aria-busy="true"]'));
  await waiting('stalled', page.getByRole('alert'));
}

/** Polls `done`, screenshotting waiting states, until it holds or the time runs out. */
async function until(what: string, done: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(ms / MIN)} min`);
    await waitingStates();
    await page.waitForTimeout(1000);
  }
}

const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const heading = (name: string | RegExp) => page.getByRole('heading', { name, exact: typeof name === 'string' });
const results = () => page.getByRole('region', { name: 'Results' });
const nav = (name: 'Learn' | 'Practice' | 'Tracks') => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
const visible = (l: Locator) => l.first().isVisible().catch(() => false);

// ---------- the learner's answers ----------

/** The newest exercise the author job saved, in the temp CODEMM_HOME. */
function newestExercise(): string {
  const courses = join(dir!, 'home', 'courses');
  const all = readdirSync(courses).flatMap((c) => {
    const ex = join(courses, c, 'exercises');
    return existsSync(ex) ? readdirSync(ex).map((s) => join(ex, s)) : [];
  });
  return all.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function files(): Promise<string[]> {
  const tabs = page.getByRole('tablist', { name: 'Files' }).getByRole('tab');
  if (await tabs.count()) return tabs.allInnerTexts();
  return [(await page.getByRole('textbox').filter({ hasNot: page.getByPlaceholder('Ask Codemm') }).first().getAttribute('aria-label')) ?? ''];
}

async function write(path: string, text: string) {
  const tab = page.getByRole('tablist', { name: 'Files' }).getByRole('tab', { name: path, exact: true });
  if (await tab.count()) await tab.click();
  await page.getByRole('textbox', { name: path, exact: true }).fill(text);
}

async function wrongAnswer(n: number) {
  const [first] = await files();
  await write(first, `${await page.getByRole('textbox', { name: first, exact: true }).inputValue()}\n${n % 2 ? '#' : '//'} not yet ${n}\n`);
}

async function rightAnswer() {
  const solution = join(newestExercise(), 'solution');
  for (const path of await files()) if (existsSync(join(solution, path))) await write(path, readFileSync(join(solution, path), 'utf8'));
}

async function check(): Promise<string> {
  await button('Check').click();
  const verdict = results().getByRole('heading', { name: /passed|Try another way|wasn't counted/ });
  await until('a Check result', () => visible(verdict), 10 * MIN);
  return verdict.innerText();
}

async function ask(how: 'Hint' | 'Show me' | string): Promise<string> {
  const log = page.getByRole('log');
  const before = await log.locator(':scope > *').count();
  if (how === 'Hint' || how === 'Show me') await button(how).click();
  else {
    await page.getByRole('textbox', { name: 'Ask Codemm' }).fill(how);
    await page.getByRole('textbox', { name: 'Ask Codemm' }).press('Enter');
  }
  await until('a tutor answer', async () => (await log.locator(':scope > *').count()) >= before + 2, 8 * MIN);
  return (await log.locator(':scope > *').last().innerText()).replace(/\s+/g, ' ').slice(0, 300);
}

// ---------- moving around ----------

/** The course map, from anywhere (a relaunched app opens on the welcome screen). */
async function toMap() {
  const map = page.getByRole('list', { name: 'Topics' });
  // Right after launch the page may still be rendering: wait for a screen first.
  await until('a screen', async () => (await visible(button('Start learning'))) || (await visible(nav('Learn'))) || (await visible(map)), MIN);
  if (await visible(button('Start learning'))) await button('Start learning').click();
  else if (!(await visible(map))) await nav('Learn').click();
  await until('the course map', async () => (await visible(map)) || (await visible(heading(/ complete$/))), 2 * MIN);
}

async function nowIndex(): Promise<number> {
  await toMap();
  return page.getByRole('list', { name: 'Topics' }).getByRole('listitem').evaluateAll((els) => els.findIndex((el) => el.querySelector('[aria-label="Now"]')));
}

/** From a topic or lesson: through unread lessons to the activity, trying again on stalled work (twice). */
async function toActivity(): Promise<string> {
  let retries = 0;
  await until(
    'the activity',
    async () => {
      if (await visible(button('Try it'))) return true;
      const stalled = page.getByRole('alert').getByRole('button', { name: 'Try again' });
      if (await visible(stalled)) {
        if (++retries > 2) throw new Error(`Still stalled after 2 tries: ${(await page.getByRole('alert').innerText()).replace(/\s+/g, ' ')}`);
        appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step: 'stall-try-again', ok: true, s: 0, note: (await page.getByRole('alert').innerText()).replace(/\s+/g, ' ') })}\n`);
        await stalled.click();
      } else if ((await visible(button('Next'))) && (await button('Next').isEnabled())) await button('Next').click();
      else if (await visible(button(/^(Start|Again)$/))) await button(/^(Start|Again)$/).click();
      else if (await visible(button(/^Read /))) await button(/^Read /).first().click();
      return false;
    },
    20 * MIN,
  );
  return (await page.getByRole('heading', { level: 1 }).first().innerText()).slice(0, 80);
}

async function continueTopic(): Promise<string> {
  await toMap();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  return toActivity();
}

async function passActivity(name: string) {
  await step(name, async () => {
    const title = await continueTopic();
    await rightAnswer();
    const verdict = await check();
    expect(verdict).toMatch(/^(\d+) of \1 passed$/);
    return `${title}: ${verdict}`;
  });
}

async function launch(env: Record<string, string>) {
  app = await electron.launch({ executablePath: exe!, args: [`--user-data-dir=${join(dir!, 'userData')}`], env, cwd: dir! });
  page = await app.firstWindow();
  expect(await app.evaluate(({ app: a }) => [a.getPath('userData'), a.getPath('logs')])).toEqual([join(dir!, 'userData'), join(dir!, 'userData', 'logs')]);
}

async function connect(id: string) {
  // Right after launch the page may still be rendering: wait for the welcome or connect screen first.
  await until('the welcome or connect screen', async () => (await visible(button('Connect an agent'))) || (await visible(heading('Connect an agent'))), MIN);
  if (await visible(button('Connect an agent'))) await button('Connect an agent').click();
  const row = page.getByRole('listitem', { name: NAMES[id] });
  await expect(row).toBeVisible({ timeout: MIN });
  if (!(await visible(row.getByText('Connected')))) await row.getByRole('button', { name: 'Connect' }).click();
  await expect(row.getByText('Connected')).toBeVisible({ timeout: MIN });
  // The model, through the connect screen's Model select (saved, and passed to every job).
  if (model && id === agent) {
    await row.getByRole('combobox').selectOption(model);
    await expect(row.getByRole('combobox')).toHaveValue(model);
  }
  await button('Continue').click();
  await expect(page.getByText('This computer is ready.')).toBeVisible({ timeout: 3 * MIN });
  await button('Continue').click();
}

const docker = (command: 'stop' | 'start') => execFileSync('docker', ['desktop', command], { stdio: 'ignore', timeout: 5 * MIN });

// ---------- the journey ----------

test(`journey: ${label}`, async () => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CODEMM_HOME: join(dir!, 'home'), PATH: `${join(dir!, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ELECTRON_RUN_AS_NODE', 'CODEMM_JOURNEY', 'CODEMM_APP', 'NODE_OPTIONS']) delete env[key];
  if (part === 'no-agent') {
    // Neither PATH nor the usual install folders (under HOME) hold an agent.
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    env.HOME = join(dir!, 'empty-home');
    mkdirSync(env.HOME, { recursive: true });
  }
  const fake = join(dir!, 'fake-mode');
  // Simulated: Docker Desktop stays installed, but this run's lookup sees only PATH, which holds just the agents.
  if (part === 'no-docker') env.CODEMM_TEST_SEARCH_DIRS = '';
  // Simulated: this run's track build uses a buildx builder with no network (made by the runner).
  if (part === 'offline-setup') env.BUILDX_BUILDER = 'codemm-offline-sim';
  if (part === 'fakes' || part === 'fake-research') {
    env.PATH = `${join(dir!, 'bin-fake')}:/usr/bin:/bin:/usr/sbin:/sbin`;
    env.CODEMM_FAKE_FILE = fake;
    env.CODEMM_REAL_CLAUDE = readFileSync(join(dir!, 'real-claude'), 'utf8').trim();
  }
  const untouched = snapshot();
  await launch(env);

  if (part === 'no-agent') {
    await step('no-agent', async () => {
      await button('Connect an agent').click();
      for (const name of ['Claude Code', 'Codex']) await expect(page.getByRole('listitem', { name }).getByText('Not installed')).toBeVisible({ timeout: MIN });
      await expect(button('Continue')).toBeDisabled();
      return (await page.getByRole('link', { name: /^Get / }).evaluateAll((els) => els.map((e) => `${e.textContent} ${e.getAttribute('href')}`))).join(' / ');
    });
  } else if (part === 'repair') {
    await step('repair', async () => {
      await toMap().catch(() => undefined);
      const alert = page.getByRole('alert');
      await expect(alert).toContainText("Codemm's records need a repair.", { timeout: 2 * MIN });
      return (await alert.innerText()).replace(/\s+/g, ' ');
    });
  } else if (part === 'fakes') {
    const alertText = async () => (await page.getByRole('alert').first().innerText()).replace(/\s+/g, ' ');
    await step('fake-infra-author-topic', async () => {
      writeFileSync(fake, 'infra-author');
      await toMap();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await until('the stall banner', () => visible(page.getByRole('alert').getByRole('button', { name: 'Try again' })), 10 * MIN);
      return alertText();
    });
    await step('fake-infra-author-lesson', async () => {
      await button(/^Read /).first().click();
      await until('the stall banner beside the lesson', () => visible(page.getByRole('alert').getByRole('button', { name: 'Try again' })), 2 * MIN);
      const text = await alertText();
      rmSync(fake);
      await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
      return `${text}; Try again after the fix: ${await toActivity()}`;
    });
    await step('fake-plan-limit', async () => {
      writeFileSync(fake, 'plan-limit');
      await button('Hint').click();
      await until('the plan-limit message', () => visible(page.getByRole('alert')), 3 * MIN);
      const text = await alertText();
      rmSync(fake);
      return `${text}; after the reset: ${await ask('Hint')}`;
    });
    await step('fake-unstoppable', async () => {
      await rightAnswer();
      expect(await check()).toMatch(/^(\d+) of \1 passed$/);
      writeFileSync(fake, 'unstoppable-author');
      await toMap();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await until('the unstoppable message', async () => /couldn't stop your agent/i.test(await page.locator('body').innerText()), 15 * MIN);
      const text = await alertText().catch(() => '');
      const tryAgain = await visible(page.getByRole('alert').getByRole('button', { name: 'Try again' }));
      await app.close();
      const pid = Number(readFileSync(`${fake}.pid`, 'utf8'));
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      rmSync(fake);
      await launch(env);
      return `${text} (Try again offered: ${tryAgain}); after quitting and relaunching: ${await continueTopic()}`;
    });
    await step('fake-signed-out', async () => {
      await app.close();
      writeFileSync(fake, 'signed-out');
      await launch(env);
      await toMap();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await until('the connect screen', () => visible(heading('Connect an agent')), 5 * MIN);
      const row = (await page.getByRole('listitem', { name: 'Claude Code' }).innerText()).replace(/\s+/g, ' ');
      rmSync(fake);
      await connect('claude');
      return `${row}; signed in again: ${await toActivity()}`;
    });
    await step('repair', async () => {
      await app.close();
      const course = readdirSync(join(dir!, 'home', 'courses'))[0];
      const events = join(dir!, 'home', 'courses', course, 'events.jsonl');
      const before = readFileSync(events, 'utf8');
      writeFileSync(events, `${before}{damaged\n`);
      await launch(env);
      await toMap().catch(() => undefined);
      await until('the repair message', async () => /records need a repair/.test(await page.locator('body').innerText()), 2 * MIN);
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      await shot('repair-screen');
      await app.close();
      writeFileSync(events, before);
      await launch(env);
      await toMap();
      return `${text}; after restoring the log: course map back`;
    });
  } else if (part === 'no-docker') {
    await step('no-docker', async () => {
      await until('the welcome screen', () => visible(button('Connect an agent')), MIN);
      await button('Connect an agent').click();
      const row = page.getByRole('listitem', { name: NAMES[agent] });
      await row.getByRole('button', { name: 'Connect' }).click();
      await expect(row.getByText('Connected')).toBeVisible({ timeout: MIN });
      await button('Continue').click();
      await expect(heading('Check this computer')).toBeVisible();
      await until('the Docker step', () => visible(page.getByRole('link', { name: /^Get Docker/ })), MIN);
      return (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    });
  } else if (part === 'fake-research') {
    await step('connect', () => connect(agent));
    await step('research-offline', async () => {
      writeFileSync(fake, 'offline-research');
      await button('Start learning').click();
      await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
      await page.getByRole('textbox', { name: 'I already know' }).fill(known);
      await button('Start').click();
      await until('the research failure', () => visible(button('Try again')), 10 * MIN);
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      await shot('research-offline-failure');
      rmSync(fake);
      await button('Try again').click();
      await until('the suggested path', () => visible(button('Approve')), 15 * MIN);
      return `${text}; back online: a roadmap`;
    });
  } else if (part === 'low-disk' || part === 'docker-setup' || part === 'offline-setup') {
    await step('connect', () => connect(agent));
    await step('research', async () => {
      await button('Start learning').click();
      await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
      await page.getByRole('textbox', { name: 'I already know' }).fill(known);
      await button('Start').click();
      await until('the suggested path', () => visible(button('Approve')), 15 * MIN);
    });
    await step(part, async () => {
      await button('Approve').click();
      const consent = page.getByRole('dialog', { name: /^Set up .* on this computer\?$|^Codemm has another way/ });
      await until('the setup consent', () => visible(consent), 20 * MIN);
      await consent.getByRole('button', { name: 'Set up', exact: true }).click();
      if (part === 'docker-setup') {
        await until('setting up', () => visible(page.getByText(/^Setting up /)), MIN);
        docker('stop');
      }
      await until('the setup failure', () => visible(page.getByRole('alert')), 10 * MIN);
      const failure = (await page.getByRole('alert').innerText()).replace(/\s+/g, ' ');
      await shot(`${part}-failure`);
      if (part === 'low-disk') return failure;
      if (part === 'offline-setup') {
        // Back online: relaunch without the no-network builder, then Try again builds the same proposal.
        await app.close();
        delete env.BUILDX_BUILDER;
        await launch(env);
        await toMap();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await until('Try again', () => visible(page.getByRole('alert').getByRole('button', { name: 'Try again' })), 2 * MIN);
        await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
        await until('setup done', async () => !(await visible(page.getByText(/^(Preparing setup for|Setting up) /))) && !(await visible(page.getByRole('alert'))), 20 * MIN);
        return `${failure}; back online: set up`;
      }
      await page.getByRole('alert').getByRole('button', { name: 'Check this computer' }).click();
      execFileSync('open', ['-a', 'Docker']);
      await until('Docker ready', () => visible(page.getByText('This computer is ready.')), 6 * MIN);
      await button('Continue').click();
      await until('Try again', () => visible(page.getByRole('alert').getByRole('button', { name: 'Try again' })), 2 * MIN);
      await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
      await until('setup done', async () => !(await visible(page.getByText(/^(Preparing setup for|Setting up) /))) && !(await visible(page.getByRole('alert'))), 20 * MIN);
      return `${failure}; recovered after Docker came back`;
    });
  } else if (part === 'docker-stop') {
    await step('activity-open', continueTopic);
    await step('docker-stopped-before-check', async () => {
      docker('stop');
      await wrongAnswer(5);
      expect(await check()).toBe("This check wasn't counted");
      return (await results().innerText()).replace(/\s+/g, ' ').slice(0, 200);
    });
    await step('check-this-computer', async () => {
      await results().getByRole('button', { name: 'Check this computer' }).click();
      await expect(heading('Check this computer')).toBeVisible();
      const meanwhile = (await page.getByRole('status').innerText()).replace(/\s+/g, ' ');
      execFileSync('open', ['-a', 'Docker']);
      await until('Docker ready', () => visible(page.getByText('This computer is ready.')), 6 * MIN);
      await button('Continue').click();
      return `while stopped: ${meanwhile}`;
    });
    await step('docker-stopped-during-check', async () => {
      await until('the activity', () => visible(button('Try it')), 2 * MIN);
      await wrongAnswer(6);
      await button('Check').click();
      docker('stop');
      const verdict = results().getByRole('heading', { name: /passed|wasn't counted/ });
      await until('a Check result', () => visible(verdict), 6 * MIN);
      return verdict.innerText();
    });
    await step('docker-back', async () => {
      execFileSync('open', ['-a', 'Docker']);
      await nav('Practice').click();
      await until('Docker answering a Check', async () => {
        if (!(await visible(button('Try it')))) return false;
        await rightAnswer();
        return /^(\d+) of \1 passed$/.test(await check());
      }, 8 * MIN);
      return 'passed once Docker was back';
    });
  } else {
    if (part !== 'activity') {
      await step('connect', () => connect(agent));
      await step('research', async () => {
        await button('Start learning').click();
        await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
        await page.getByRole('textbox', { name: 'I already know' }).fill(known);
        await button('Start').click();
        await until('the suggested path', () => visible(button('Approve')), 15 * MIN);
        const titles = await page.getByRole('button', { name: /^Rename / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/^Rename /, '')));
        return `${titles.length} topics: ${titles.join(' / ')}`.slice(0, 400);
      });
      await step('edit-course', async () => {
        const did: string[] = [];
        const remove = page.getByRole('button', { name: /^Remove / });
        // A small course: three topics, removing from the end (later topics need earlier ones).
        while ((await remove.count()) > 3) {
          const last = remove.nth((await remove.count()) - 1);
          const title = (await last.getAttribute('aria-label'))!.replace(/^Remove /, '');
          await last.click();
          await expect(page.getByRole('button', { name: `Remove ${title}`, exact: true })).toHaveCount(0);
        }
        did.push('trimmed to 3');
        const rename = page.getByRole('button', { name: /^Rename / }).first();
        await rename.click();
        const box = page.getByRole('textbox', { name: 'Topic name' });
        await box.fill(`${await box.inputValue()} basics`);
        await box.press('Enter');
        did.push('renamed the first');
        const addRows = async (at: string) => {
          await shot(`edit-${at}`);
          const open = await page.getByRole('textbox', { name: 'Topic name' }).count();
          if (open) did.push(`an edit row stayed open after ${at}`);
        };
        await addRows('rename');
        if (flow.has('edits')) {
          // Reorder: move the second topic down; a prerequisite may refuse it, with a reason.
          const move = page.getByRole('button', { name: /^Move / }).nth(1);
          await move.click();
          await page.getByRole('menuitem', { name: 'Move down' }).click();
          const refused = page.getByRole('alert');
          did.push((await visible(refused)) ? `reorder refused: ${(await refused.innerText()).replace(/\s+/g, ' ')}` : 'moved the second down');
          await addRows('reorder');
          // Add, then remove, a topic.
          await button('Add a topic').click();
          await page.getByRole('textbox', { name: 'Topic name' }).fill('Practice review');
          await page.getByRole('textbox', { name: 'Topic name' }).press('Enter');
          await expect(button('Remove Practice review')).toBeVisible();
          await addRows('add');
          await button('Remove Practice review').click();
          did.push('added and removed a topic');
          await addRows('remove');
          // Ask Codemm for a change.
          const before = await page.getByRole('button', { name: /^Rename / }).count();
          await page.getByRole('textbox', { name: 'Ask Codemm for changes' }).fill('Add a short topic on docstrings at the end.');
          await page.getByRole('textbox', { name: 'Ask Codemm for changes' }).press('Enter');
          await until('the roadmap change', async () => (await page.getByRole('button', { name: /^Rename / }).count()) !== before || (await visible(page.getByRole('status'))), 10 * MIN);
          did.push(`asked for a change: ${before} → ${await page.getByRole('button', { name: /^Rename / }).count()} topics`);
          await addRows('ask');
        }
        return did.join('; ');
      });
      await step('consent-setup', async () => {
        await button('Approve').click();
        const consent = page.getByRole('dialog', { name: /^Set up .* on this computer\?$|^Codemm has another way/ });
        const busy = page.getByText(/^(Preparing setup for|Setting up) /);
        const approved: string[] = [];
        let idle = 0;
        let relaunched = false;
        const deadline = Date.now() + 40 * MIN;
        while (idle < 5) {
          if (Date.now() > deadline) throw new Error(`Setup not done within 40 minutes (${approved.length} proposals approved)`);
          await waitingStates();
          if (await visible(page.getByRole('alert'))) throw new Error(`Setup failed: ${(await page.getByRole('alert').innerText()).replace(/\s+/g, ' ')}`);
          if (await visible(consent)) {
            approved.push((await consent.getByRole('heading').first().innerText()).trim());
            await shot(`consent-${approved.length}`);
            await consent.getByRole('button', { name: 'Set up', exact: true }).click();
            idle = 0;
          } else if (flow.has('relaunch-setup') && !relaunched && (await visible(page.getByText(/^Setting up /)))) {
            // Quit mid-setup, then come back.
            relaunched = true;
            await app.close();
            await launch(env);
            await toMap();
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            approved.push('quit and relaunched mid-setup');
          } else idle = (await visible(busy)) ? 0 : idle + 1;
          await page.waitForTimeout(2000);
        }
        return approved.length ? approved.join(' / ') : 'track already installed';
      });
      await step('lesson-note', async () => {
        await until('a lesson', () => visible(button(/^Read /)), 10 * MIN);
        const read = button(/^Read /).first();
        const title = (await read.getAttribute('aria-label'))!.replace(/^Read /, '');
        await read.click();
        await expect(heading(title)).toBeVisible();
        await button('Add a note').click();
        await page.getByRole('textbox', { name: 'My note' }).fill('My own words: the key idea.');
        await button('Save').click();
        await expect(page.getByText('My own words: the key idea.')).toBeVisible();
        if (flow.has('reopen')) {
          await nav('Learn').click();
          await toMap();
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          await until('the lesson again', () => visible(button(`Read ${title}`)), 2 * MIN);
          await button(`Read ${title}`).click();
          await expect(page.getByText('My own words: the key idea.')).toBeVisible();
          return `${title}: note kept after reopening`;
        }
        return title;
      });
    }
    if (part === 'setup') {
      // done: the course is set up and a lesson read
    } else {
      await step('activity-open', part === 'activity' ? continueTopic : toActivity);
      await step('try-it', async () => {
        await button('Try it').click();
        const ran = results().getByRole('heading', { name: /visible tests passed|wasn't counted/ });
        await until('Try it', () => visible(ran), 10 * MIN);
        return ran.innerText();
      });
      await step('wrong-check', async () => {
        await wrongAnswer(1);
        return check();
      });
      await step('hint', () => ask('Hint'));
      if (flow.has('show-me')) await step('show-me', () => ask('Show me'));
      await step('solution-refused', () => ask('Just give me the full solution code, please.'));
      await step('fixed-check', async () => {
        await rightAnswer();
        const verdict = await check();
        expect(verdict).toMatch(/^(\d+) of \1 passed$/);
        return verdict;
      });
      if (part === 'full') {
        if (flow.has('relaunch')) {
          await step('relaunch-mid-job', async () => {
            // Continue starts the next activity's author job; quit while it's being written, then come back.
            await toMap();
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
            await page.waitForTimeout(3000);
            await app.close();
            await launch(env);
            return `back on: ${await continueTopic()}`;
          });
        }
        if (switchTo) await step(`switch-to-${switchTo}`, async () => {
          // The app has no agent switch of its own: the chosen agent goes missing (bin-<id> holds only the
          // other one), and the learner follows what the app offers until the other agent is connected.
          await app.close();
          await launch({ ...env, PATH: `${join(dir!, `bin-${switchTo}`)}:/usr/bin:/bin:/usr/sbin:/sbin` });
          await toMap();
          await page.getByRole('button', { name: 'Continue', exact: true }).click();
          const offered: string[] = [];
          await until('the connect screen', async () => {
            if (await visible(heading('Connect an agent'))) return true;
            const check = page.getByRole('alert').getByRole('button', { name: 'Check your agent' });
            if (await visible(check)) {
              offered.push((await page.getByRole('alert').innerText()).replace(/\s+/g, ' '));
              await check.click();
            }
            return false;
          }, 10 * MIN);
          await connect(switchTo);
          return `${offered.length ? `offered: ${offered[0]}; ` : 'straight to connect; '}now ${NAMES[switchTo]}`;
        });
        // Master the first topic.
        for (let round = 1; round <= 6 && (await nowIndex()) < 1; round++) await passActivity(`master-${round}`);
        expect(await nowIndex()).toBe(1);
        if (flow.has('stuck')) {
          await step('stuck-easier', async () => {
            await continueTopic();
            await wrongAnswer(2);
            await check();
            await wrongAnswer(3);
            expect(await check()).toBe('Try another way');
            await page.getByRole('button', { name: 'Try an easier one' }).click();
            await until('the easier topic', async () => (await visible(page.getByRole('list', { name: 'Topics' }))) && (await page.getByRole('list', { name: 'Topics' }).getByRole('listitem').count()) > 3, 15 * MIN);
            return (await page.getByRole('list', { name: 'Topics' }).getByRole('listitem').allInnerTexts()).map((t) => t.split('\n')[0]).join(' / ');
          });
        }
        await step('skip', async () => {
          await continueTopic();
          await wrongAnswer(4);
          await check();
          await wrongAnswer(5);
          expect(await check()).toBe('Try another way');
          await page.getByRole('button', { name: 'Come back later' }).click();
          await toMap();
        });
      }
      await step('progress', async () => {
        await toMap();
        return (await page.getByRole('list', { name: 'Topics' }).getByRole('img').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).join(', ');
      });
      if (flow.has('pages')) {
        await step('practice-page', async () => {
          await nav('Practice').click();
          await page.waitForTimeout(1500);
          return (await page.getByRole('heading', { level: 1 }).first().innerText().catch(() => '')).slice(0, 80);
        });
        await step('tracks-page', async () => {
          await nav('Tracks').click();
          await expect(heading('Tracks')).toBeVisible();
          return (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 200);
        });
      }
      if (part === 'full') {
        for (let round = 1; round <= 20 && !(await visible(heading(/ complete$/))); round++) {
          await toMap();
          if (await visible(heading(/ complete$/))) break;
          await passActivity(`complete-${round}`);
        }
        await step('course-complete', async () => {
          await toMap();
          await expect(heading(/ complete$/)).toBeVisible();
          return heading(/ complete$/).innerText();
        });
        if (flow.has('new-course')) {
          await step('new-course', async () => {
            await button('Learn something new').click();
            await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
            await page.getByRole('textbox', { name: 'I already know' }).fill('HTML and JavaScript');
            await button('Start').click();
            await until('the new suggested path', () => visible(button('Approve')), 15 * MIN);
            return `${await page.getByRole('button', { name: /^Rename / }).count()} topics for React`;
          });
        }
      }
    }
  }

  await app.close();
  // Isolation: the run used its own folders only. Anything that wrote to the real ones is a bug.
  expect(snapshot(), "the run changed the learner's real Codemm data, profile or log").toEqual(untouched);
});
