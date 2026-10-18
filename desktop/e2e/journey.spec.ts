import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
//   JOURNEY_TOPIC=<goal>    what to learn (default "Python functions"); JOURNEY_KNOWN=<what's known>;
//   JOURNEY_DEPTH=Overview|Standard|In depth   chosen on the goal screen (default: leave Standard)
//   JOURNEY_PART=full|setup|activity|first-run|no-docker|docker-stop|docker-setup|low-disk|offline-setup|fake-research|fakes|update
//                           (`first-run`: no agents and Docker hidden; installs both agents in the app into a temp
//                           HOME, and starts Docker's download only to stop it; `update`: the unpackaged app from
//                           JOURNEY_DESKTOP against a local update feed)
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
const depth = process.env.JOURNEY_DEPTH;
const flow = new Set((process.env.JOURNEY_FLOW ?? '').split(',').filter(Boolean));
const switchTo = [...flow].find((f) => f.startsWith('switch='))?.slice('switch='.length);
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
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
    await everyScreen(`${name}${ok ? '' : ' failed'}`).catch(() => undefined);
    appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step: name, ok, s: Math.round((Date.now() - began) / 1000), note })}\n`);
    await shot(name).catch(() => undefined);
  }
}

async function shot(name: string) {
  mkdirSync(join(dir!, 'shots'), { recursive: true });
  // The test-run banner stays out of the screenshots used for the visual review.
  const banner = (on: boolean) =>
    page
      .evaluate(([show, text]) => {
        document.getElementById('journey-banner')?.style.setProperty('display', show ? 'block' : 'none');
        const bar = document.querySelector('.tbar');
        if (bar?.hasAttribute('data-title')) bar.textContent = show ? text : bar.getAttribute('data-title');
      }, [on, LABEL] as const)
      .catch(() => undefined);
  await banner(false);
  // Screens fade in: wait for running animations so the shot shows the settled screen.
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 3000))])).catch(() => undefined);
  await page.screenshot({ path: join(dir!, 'shots', `${label}-${name}.jpg`), type: 'jpeg', quality: 60 });
  await banner(true);
}

let lateConsents = 0;

/** Copies the proposals the learner is about to approve, so a gate failure can be diagnosed after the app drops them. */
function keepProposals(n: number) {
  const from = join(dir!, 'home', 'proposals');
  if (existsSync(from)) cpSync(from, join(dir!, 'proposals', `consent-${n}`), { recursive: true });
}

/** Screenshots a waiting state the first time it shows. */
async function waiting(name: string, locator: Locator) {
  if (seen.has(name) || !(await locator.first().isVisible().catch(() => false))) return;
  seen.add(name);
  await shot(`waiting-${name}`);
}

/** Every waiting state the app shows, checked while the driver waits. */
/**
 * JOURNEY_WALKTHROUGH=<dir>: a human-perspective record. Every time the screen changes (its text or its dialog), a
 * numbered screenshot goes to <dir> (shared across runs through <dir>/.count) with a one-line caption in captions.md.
 */
const walkDir = process.env.JOURNEY_WALKTHROUGH;
let lastScreen = '';
async function everyScreen(why = '') {
  if (!walkDir) return;
  const text = await page.locator('body').innerText().catch(() => '');
  const sig = text.replace(/\d+:\d\d|\d+%|\d+ (of|steps?)\b.*$/gm, '#').replace(/\s+/g, ' ').slice(0, 4000);
  if (!why && sig === lastScreen) return;
  lastScreen = sig;
  mkdirSync(walkDir, { recursive: true });
  const countFile = join(walkDir, '.count');
  const n = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
  writeFileSync(countFile, String(n));
  const file = `${String(n).padStart(3, '0')}.jpg`;
  const banner = (on: boolean) => page.evaluate(([show, t]) => { document.getElementById('journey-banner')?.style.setProperty('display', show ? 'block' : 'none'); const bar = document.querySelector('.tbar'); if (bar?.hasAttribute('data-title')) bar.textContent = show ? t : bar.getAttribute('data-title'); }, [on, LABEL] as const).catch(() => undefined);
  await banner(false);
  await page.screenshot({ path: join(walkDir, file), type: 'jpeg', quality: 70 }).catch(() => undefined);
  await banner(true);
  const dialog = await page.getByRole('dialog').first().innerText().catch(() => '');
  const h1 = await page.getByRole('heading', { level: 1 }).first().innerText({ timeout: 500 }).catch(() => '');
  const alert = await page.getByRole('alert').first().innerText({ timeout: 500 }).catch(() => '');
  const caption = [why && `[${why}]`, dialog ? `dialog: ${dialog.split('\n')[0]}` : h1 || text.split('\n').find((l) => l.trim()) || '', alert && `alert: ${alert.replace(/\s+/g, ' ')}`].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 220);
  appendFileSync(join(walkDir, 'captions.md'), `- ${file}: ${caption} (${label})\n`);
}

async function waitingStates() {
  await everyScreen();
  await waiting('research', page.getByRole('heading', { name: /^Researching / }));
  await waiting('preparing-setup', page.getByText(/^Preparing setup for /));
  await waiting('setting-up', page.getByText(/^Setting up /));
  await waiting('writing-lesson', page.getByRole('img', { name: 'Writing' }));
  await waiting('writing-activity', page.getByRole('img', { name: /Writing the activity|Being written/ }));
  await waiting('checking', page.getByText(/^(Checking|Running)/));
  await waiting('tutor-answering', page.locator('[role="log"][aria-busy="true"]'));
  await waiting('stalled', page.getByRole('alert'));
  // A setup proposal can arrive late, for example after a relaunch mid-setup.
  const consent = page.getByRole('dialog', { name: /^Set up .* on this computer\?$|^Codemm has another way/ });
  if (await visible(consent)) {
    await shot('consent-late');
    note('consent-late', (await consent.getByRole('heading').first().innerText()).trim());
    keepProposals(++lateConsents + 100);
    await tap(consent.getByRole('button', { name: 'Set up', exact: true }));
  }
}

/** Clicks if the element stays put; a re-rendered button is retried on the next poll. */
const tap = (l: Locator) => l.click({ timeout: 5000 }).then(() => true, () => false);
const note = (step: string, text: string) => appendFileSync(join(dir!, 'results.jsonl'), `${JSON.stringify({ label, step, ok: true, s: 0, note: text })}\n`);

/** Polls `done`, screenshotting waiting states, until it holds or the time runs out. */
async function until(what: string, done: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    await waitingStates();
    if (await done()) break;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(ms / MIN)} min`);
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

/** The open activity's exercise: the one whose README title is the page's heading, else the newest. */
async function openExercise(): Promise<string> {
  const title = (await page.locator('h1').first().innerText()).trim();
  const courses = join(dir!, 'home', 'courses');
  const all = readdirSync(courses).flatMap((c) => {
    const ex = join(courses, c, 'exercises');
    return existsSync(ex) ? readdirSync(ex).map((s) => join(ex, s)) : [];
  });
  // Titles can repeat across a course (a review reuses an old exercise): prefer the one whose statement is on the
  // page, then the newest with this title.
  const shown = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const statement = (d: string) => readFileSync(join(d, 'README.md'), 'utf8').split('\n').slice(1).join(' ').replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const titled = all
    .filter((d) => existsSync(join(d, 'README.md')) && readFileSync(join(d, 'README.md'), 'utf8').split('\n')[0].replace(/^#\s*/, '').trim() === title)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return titled.find((d) => { const st = statement(d); return st.length > 20 && shown.includes(st.slice(0, 40)); }) ?? titled[0] ?? newestExercise();
}

async function rightAnswer() {
  const solution = join(await openExercise(), 'solution');
  for (const path of await files()) if (existsSync(join(solution, path))) await write(path, readFileSync(join(solution, path), 'utf8'));
}

/** The live phases the last Check showed while it ran (Building, Visible tests 1 of 3, Hidden tests...). */
let livePhases: string[] = [];

async function check(): Promise<string> {
  await button('Check').click();
  const verdict = results().getByRole('heading', { name: /passed|Try another way|wasn't counted/ });
  livePhases = [];
  await until('a Check result', async () => {
    const bar = results().getByRole('progressbar');
    if (await visible(bar)) {
      const now = `${await bar.first().getAttribute('aria-label').catch(() => '')} ${(await bar.first().getAttribute('aria-valuenow').catch(() => null)) ?? ''}`.trim();
      if (now && livePhases.at(-1) !== now) livePhases.push(now);
      await waiting('check-live', bar);
    }
    return visible(verdict);
  }, 10 * MIN);
  // Stuck shows "Try another way" above the count.
  if (await visible(results().getByRole('heading', { name: 'Try another way' }))) return 'Try another way';
  return verdict.first().innerText();
}

/** A lesson's runnable example: Run it, and read what it printed (or why it didn't run). */
async function exampleRun(): Promise<string> {
  const example = page.getByRole('region', { name: /^Example \d+$/ }).first();
  if (!(await visible(example))) return 'no runnable example in this lesson';
  const name = (await example.getAttribute('aria-label')) ?? 'Example';
  await example.getByRole('button', { name: 'Run', exact: true }).click();
  const out = example.getByRole('status');
  const log = page.getByRole('log', { name: new RegExp(`^Terminal for ${name}, as text$`) });
  // An interactive example waits for a line: type one once its input opens.
  const input = page.getByRole('textbox', { name: `Terminal for ${name} input` });
  await until('the example to start', async () => (await input.isEnabled().catch(() => false)) || (await visible(out)) || ((await visible(log)) && /Exited|failed|stopped/i.test(await log.innerText())), MIN).catch(() => undefined);
  if (await input.isEnabled().catch(() => false)) {
    await input.pressSequentially('Ada');
    await input.press('Enter');
  }
  await until('the example output', async () => (await visible(log)) ? /Exited|stopped|failed|Time's up/i.test(await log.innerText()) : (await visible(out)) && (await out.innerText()).trim().length > 0, 3 * MIN);
  await shot('example-run');
  const text = (await visible(log)) ? await log.innerText() : await out.innerText();
  if (await visible(example.getByRole('button', { name: 'Stop', exact: true }))) await example.getByRole('button', { name: 'Stop', exact: true }).click();
  return `${name}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
}

/** Run with input: the learner's program in the terminal, one typed line sent to it. */
async function runWithInput(): Promise<string> {
  const title = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
  const run = page.getByRole('button', { name: 'Run', exact: true });
  if (!(await visible(run))) return 'no Run for this activity (not an io track)';
  await run.click();
  const input = page.getByRole('textbox', { name: `Terminal for ${title} input` });
  const log = page.getByRole('log', { name: `Terminal for ${title}, as text` });
  await until('the program to start', async () => (await visible(log)) && ((await input.isEnabled().catch(() => false)) || /Exited|failed|stopped|Time's up/i.test(await log.innerText())), 5 * MIN);
  // A program may read several lines: send a few numbers, one per line, while it still takes input.
  for (const line of ['3', '4', '5']) {
    if (!(await input.isEnabled().catch(() => false)) || /Exited|failed|stopped|Time's up/i.test(await log.innerText())) break;
    await input.pressSequentially(line);
    await input.press('Enter');
    await page.waitForTimeout(1500);
  }
  await until('the program to end', async () => /Exited with code|build failed|stopped|Time's up|ran out of memory|wasn't taken/i.test(await log.innerText()), 3 * MIN).catch(async () => {
    await run.click(); // Stop
  });
  await shot('run-with-input');
  return (await log.innerText()).replace(/\s+/g, ' ').slice(-240);
}

async function ask(how: 'Hint' | 'Show me' | string): Promise<string> {
  const log = page.getByRole('log');
  const idle = async () => (await log.getAttribute('aria-busy').catch(() => null)) !== 'true' && !/Codemm is thinking/.test(await log.locator(':scope > *').last().innerText().catch(() => ''));
  // One question at a time: while Codemm answers, Send is off and Enter does nothing.
  await until('the tutor to be free', idle, 8 * MIN);
  const before = await log.locator(':scope > *').count();
  if (how === 'Hint' || how === 'Show me') await button(how).click();
  else {
    await page.getByRole('textbox', { name: 'Ask Codemm' }).fill(how);
    await button('Send').click();
  }
  await until('a tutor answer', async () => (await log.locator(':scope > *').count()) >= before + 2 && (await idle()), 8 * MIN);
  return (await log.locator(':scope > *').last().innerText()).replace(/\s+/g, ' ').slice(0, 300);
}

// ---------- moving around ----------

/** The course map, from anywhere (a relaunched app opens on the welcome screen). */
/**
 * To the course map. A relaunch whose chosen agent is missing or signed out opens on the welcome screen's
 * Connect an agent instead: then it stops there and says so.
 */
async function toMap(): Promise<'map' | 'welcome'> {
  const map = page.getByRole('list', { name: 'Topics' });
  const welcome = button('Connect an agent');
  // Right after launch the page may still be rendering: wait for a screen first.
  await until('a screen', async () => (await visible(button('Start learning'))) || (await visible(welcome)) || (await visible(nav('Learn'))) || (await visible(map)), MIN);
  if (await visible(welcome)) return 'welcome';
  if (await visible(button('Start learning'))) await button('Start learning').click();
  else if (!(await visible(map))) await nav('Learn').click();
  await until('the course map', async () => (await visible(map)) || (await visible(heading(/ complete$/))), 2 * MIN);
  return 'map';
}

/** The goal screen, from the welcome screen or wherever connect left off. */
async function toGoal() {
  const goal = page.getByRole('textbox', { name: 'What do you want to learn?' });
  await until('the goal screen', async () => {
    if (await visible(button('Start learning'))) await tap(button('Start learning'));
    return visible(goal);
  }, MIN);
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
      } else if ((await visible(button('Next'))) && (await button('Next').isEnabled({ timeout: 1000 }).catch(() => false))) await tap(button('Next'));
      else if (await visible(button(/^(Start|Again)$/))) await tap(button(/^(Start|Again)$/).first());
      else if (await visible(button(/^Read /))) await tap(button(/^Read /).first());
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
  // `update` runs the unpackaged app (the packaged one ignores CODEMM_UPDATE_FEED): Electron with the desktop folder.
  // JOURNEY_MOCK=<scenario> also runs it unpackaged, on the mock: a quick check of the driver's selectors, no agents.
  const unpacked = part === 'update' || process.env.JOURNEY_MOCK !== undefined ? [process.env.JOURNEY_DESKTOP ?? process.cwd()] : [];
  if (process.env.JOURNEY_MOCK !== undefined) env = { ...env, CODEMM_MOCK: process.env.JOURNEY_MOCK };
  app = await electron.launch({ ...(unpacked.length ? {} : { executablePath: exe! }), args: [...unpacked, `--user-data-dir=${join(dir!, 'userData')}`], env, cwd: dir! });
  page = await app.firstWindow();
  expect(await app.evaluate(({ app: a }) => [a.getPath('userData'), a.getPath('logs')])).toEqual([join(dir!, 'userData'), join(dir!, 'userData', 'logs')]);
  await labelWindow();
  // Walkthrough: also look for a changed screen every 0.8 s between the driver's own waits.
  if (walkDir && !walkTimer) walkTimer = setInterval(() => {
    if (walking) return;
    walking = true;
    void everyScreen().finally(() => (walking = false));
  }, 800);
}

let walkTimer: ReturnType<typeof setInterval> | undefined;
let walking = false;

const LABEL = "Codemm — automated test run, please don't use";

/** Marks the driver's window so nobody mistakes it for their own Codemm: its title, and a thin banner (driver-only). */
async function labelWindow() {
  await app.evaluate(({ BrowserWindow }, title) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.setTitle(title);
      w.on('page-title-updated', (e) => e.preventDefault());
    }
  }, LABEL);
  await page.evaluate((text) => {
    const banner = document.createElement('div');
    banner.id = 'journey-banner';
    banner.setAttribute('aria-hidden', 'true');
    banner.textContent = text;
    Object.assign(banner.style, {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647', pointerEvents: 'none',
      background: '#b42318', color: '#fff', font: '600 12px system-ui, sans-serif', textAlign: 'center', padding: '3px 0',
    });
    document.body.appendChild(banner);
    // The window hides the OS title bar, so Codemm's own bar is the title people see.
    const bar = document.querySelector('.tbar');
    if (bar) {
      bar.setAttribute('data-title', bar.textContent ?? '');
      bar.textContent = text;
    }
  }, LABEL);
  // One screenshot with the label showing, as evidence it is there.
  mkdirSync(join(dir!, 'shots'), { recursive: true });
  if (!existsSync(join(dir!, 'shots', `${label}-test-run-label.jpg`))) await page.screenshot({ path: join(dir!, 'shots', `${label}-test-run-label.jpg`), type: 'jpeg', quality: 60 });
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
  // A computer that is already ready is skipped: the app goes on to the goal, the welcome or the course.
  await until('past the computer check', async () => {
    if (await visible(page.getByText('This computer is ready.'))) await tap(button('Continue'));
    return (await visible(page.getByRole('textbox', { name: 'What do you want to learn?' }))) || (await visible(button('Start learning'))) || (await visible(nav('Learn')));
  }, 3 * MIN);
}

const docker = (command: 'stop' | 'start') => execFileSync('docker', ['desktop', command], { stdio: 'ignore', timeout: 5 * MIN });

// ---------- the journey ----------

test(`journey: ${label}`, async () => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CODEMM_HOME: join(dir!, 'home'), PATH: `${join(dir!, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ELECTRON_RUN_AS_NODE', 'CODEMM_JOURNEY', 'CODEMM_APP', 'NODE_OPTIONS']) delete env[key];
  if (part === 'first-run') {
    // No agent anywhere (a fresh HOME: the app installs into it), Docker hidden (simulated), downloads in the run.
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    env.HOME = join(dir!, 'empty-home');
    // Only the fresh HOME's agent folders, where the app's installs land: Docker's (/usr/local/bin, /Applications)
    // stay hidden. An empty list would hide the installed agents too.
    env.CODEMM_TEST_SEARCH_DIRS = [join(env.HOME, '.local', 'bin'), join(env.HOME, '.claude', 'local')].join(':');
    env.TMPDIR = join(dir!, 'tmp');
    for (const d of [env.HOME, env.TMPDIR]) mkdirSync(d, { recursive: true });
  }
  let feedServer: ReturnType<typeof createServer> | undefined;
  if (part === 'update') {
    // A local feed offering 99.0.0, the way smoke.spec.ts does: the unsigned dev app only says a version is out.
    const feed = ['version: 99.0.0', 'files:', '  - url: Codemm-99.0.0-mac-arm64.zip', '    sha512: AAAA', '    size: 1', 'path: Codemm-99.0.0-mac-arm64.zip', 'sha512: AAAA', "releaseDate: '2026-10-01T00:00:00.000Z'", ''].join('\n');
    feedServer = createServer((req, res) => (new URL(req.url ?? '/', 'http://feed').pathname.endsWith('.yml') ? res.writeHead(200, { 'content-type': 'text/yaml' }).end(feed) : res.writeHead(404).end()));
    await new Promise<void>((r) => feedServer!.listen(0, '127.0.0.1', r));
    env.CODEMM_UPDATE_FEED = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/`;
  }
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
  } else if (part === 'first-run') {
    await step('first-run-welcome', async () => {
      await until('the welcome screen', () => visible(button('Connect an agent')), MIN);
      const offer = await visible(button("Install what's missing"));
      if (offer) {
        await button("Install what's missing").click();
        await expect(heading('Set up this computer')).toBeVisible();
        await shot('setup-this-computer');
        const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
        await button('Do it myself').click();
        return `offered Install what's missing: ${text}`;
      }
      await button('Connect an agent').click();
      return 'no install offer';
    });
    for (const name of ['Claude Code', 'Codex']) {
      await step(`install-${name === 'Codex' ? 'codex' : 'claude'}`, async () => {
        if (!(await visible(heading('Connect an agent')))) await button('Connect an agent').click();
        const row = page.getByRole('listitem', { name });
        await expect(row.getByText('Not installed')).toBeVisible({ timeout: MIN });
        await row.getByRole('button', { name: 'Install', exact: true }).click();
        const phases: string[] = [];
        await until(`${name} installed`, async () => {
          const bar = row.getByRole('progressbar');
          if (await visible(bar)) {
            const p = ((await bar.getAttribute('aria-label')) ?? '').trim();
            if (p && phases.at(-1) !== p) {
              phases.push(p);
              await shot(`install-${name === 'Codex' ? 'codex' : 'claude'}-${phases.length}`);
            }
          }
          if (await visible(row.getByRole('alert'))) throw new Error(`Install failed: ${await row.getByRole('alert').innerText()}`);
          return (await visible(row.getByText('Connected'))) || (await visible(row.getByRole('button', { name: /^(Connect|Sign in)$/ })));
        }, 10 * MIN);
        const state = (await visible(row.getByRole('button', { name: 'Sign in' }))) ? 'installed, signed out (Codemm never signs in)' : 'installed, ready to connect';
        if (await visible(row.getByRole('button', { name: 'Connect', exact: true }))) await row.getByRole('button', { name: 'Connect', exact: true }).click();
        await shot(`installed-${name === 'Codex' ? 'codex' : 'claude'}`);
        return `${phases.join(' / ')}: ${state}${(await visible(row.getByText('Connected'))) ? '; connected' : ''}`;
      });
    }
    await step('docker-offer', async () => {
      // Both installed agents may be signed out, and Codemm never signs in: then the owner's own Claude Code
      // (already signed in) goes on PATH, so Continue opens, still with Docker hidden.
      if (!(await button('Continue').isEnabled().catch(() => false))) {
        await app.close();
        // The owner's Claude Code reads its sign-in from the real HOME; Codemm's own data stays in the run's folders.
        env.PATH = `${join(dir!, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`;
        env.HOME = homedir();
        await launch(env);
        await until('the connect screen', async () => {
          if (await visible(button('Connect an agent'))) await tap(button('Connect an agent'));
          return visible(heading('Connect an agent'));
        }, MIN);
        const row = page.getByRole('listitem', { name: 'Claude Code' });
        if (!(await visible(row.getByText('Connected')))) await row.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(row.getByText('Connected')).toBeVisible({ timeout: MIN });
      }
      await button('Continue').click();
      await expect(heading('Check this computer')).toBeVisible({ timeout: MIN });
      await until('the Docker offer', () => visible(button('Install Docker')), 2 * MIN);
      await shot('docker-offer');
      const offer = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      await button('Install Docker').click();
      const progress = page.getByRole('progressbar');
      await until("Docker's download to start", async () => (await visible(progress)) && /Downloading Docker Desktop/.test((await progress.first().getAttribute('aria-label')) ?? ''), 3 * MIN);
      await shot('docker-downloading');
      // There is no Cancel: closing the app stops the download, and the partial file goes with the run's own temp folder.
      await app.close();
      const partial = readdirSync(env.TMPDIR).filter((f) => f.startsWith('codemm-docker-'));
      for (const f of partial) rmSync(join(env.TMPDIR, f), { recursive: true, force: true });
      expect(existsSync('/Applications/Docker.app')).toBe(true);
      await launch(env);
      return `${offer}; download started, stopped by quitting, ${partial.length} partial folder(s) deleted; Docker Desktop untouched`;
    });
  } else if (part === 'update') {
    await step('update-notice', async () => {
      await connect(agent);
      const goal = page.getByRole('textbox', { name: 'What do you want to learn?' });
      await until('the goal screen', async () => {
        if (await visible(button('Start learning'))) await tap(button('Start learning'));
        return visible(goal);
      }, MIN);
      const notice = page.getByRole('status', { name: 'Codemm updates' });
      await until('the update notice', async () => /new version is available/i.test(await notice.innerText().catch(() => '')), 2 * MIN);
      await shot('update-notice');
      const link = await notice.getByRole('link').getAttribute('href');
      return `${(await notice.innerText()).replace(/\s+/g, ' ')} (${link})`;
    });
    feedServer?.close();
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
      // The author's deadline (15 min) plus the stop's grace: one run needed 17 min.
      await until('the unstoppable message', async () => /couldn't stop your agent/i.test(await page.locator('body').innerText()), 25 * MIN);
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
      // A signed-out agent at launch: the welcome screen offers Connect an agent, which shows the sign-in fix.
      await until('the welcome screen', () => visible(button('Connect an agent')), MIN);
      await shot('fake-signed-out-welcome');
      await button('Connect an agent').click();
      await until('the connect screen', () => visible(heading('Connect an agent')), 5 * MIN);
      const row = (await page.getByRole('listitem', { name: 'Claude Code' }).innerText()).replace(/\s+/g, ' ');
      rmSync(fake);
      await connect('claude');
      return `${row}; signed in again: ${await toActivity()}`;
    });
    await step('stale-refresh', async () => {
      // A re-read that fails after a good one keeps the screen and says so: damage the log while the map is open,
      // then let the window's focus re-read it.
      await toMap();
      const course = readdirSync(join(dir!, 'home', 'courses'))[0];
      const events = join(dir!, 'home', 'courses', course, 'events.jsonl');
      const before = readFileSync(events, 'utf8');
      writeFileSync(events, `${before}{damaged\n`);
      const stale = page.getByRole('status').filter({ hasText: "Codemm couldn't refresh this." });
      await until('the stale banner', async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return visible(stale);
      }, 2 * MIN);
      await shot('stale-refresh');
      const text = (await stale.innerText()).replace(/\s+/g, ' ');
      const mapKept = await visible(page.getByRole('list', { name: 'Topics' }));
      writeFileSync(events, before);
      await stale.getByRole('button', { name: 'Try again' }).click();
      await until('the banner to clear', async () => !(await visible(stale)), MIN);
      return `${text} (map kept: ${mapKept}); after the fix and Try again: cleared`;
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
      await toGoal();
      await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
      await page.getByRole('textbox', { name: 'What you already know (optional)' }).fill(known);
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
      await toGoal();
      await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
      await page.getByRole('textbox', { name: 'What you already know (optional)' }).fill(known);
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
        await toGoal();
        await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill(topic);
        await page.getByRole('textbox', { name: 'What you already know (optional)' }).fill(known);
        if (depth) await page.getByRole('radiogroup', { name: 'How deep' }).getByRole('radio', { name: depth }).check();
        await button('Start').click();
        await until('the suggested path', () => visible(button('Approve')), 15 * MIN);
        const titles = await page.getByRole('button', { name: /^Rename / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/^Rename /, '')));
        const sources = await page.getByRole('region', { name: 'Sources' }).getByRole('link').allInnerTexts().catch(() => []);
        if (sources.length) await shot('research-sources');
        note('research-sources', sources.length ? `${sources.length} sources: ${sources.slice(0, 4).join(' / ')}` : 'no sources shown');
        return `${depth ?? 'Standard'}: ${titles.length} topics: ${titles.join(' / ')}`.slice(0, 600);
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
          // Go deeper on the first topic: Codemm splits it into smaller skills.
          const deeperBefore = await page.getByRole('button', { name: /^Rename / }).count();
          await page.getByRole('button', { name: /^Go deeper on / }).first().click();
          await until('the deeper roadmap', async () => (await page.getByRole('button', { name: /^Rename / }).count()) !== deeperBefore, 10 * MIN);
          did.push(`went deeper on the first: ${deeperBefore} → ${await page.getByRole('button', { name: /^Rename / }).count()} topics`);
          await addRows('go-deeper');
          // Ask Codemm for a change.
          const before = await page.getByRole('button', { name: /^Rename / }).count();
          await page.getByRole('textbox', { name: 'Ask Codemm for changes' }).fill('Add a short topic on docstrings at the end.');
          await button('Apply').click();
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
          // The late-consent handler (waitingStates) may have just approved it: then the dialog is gone.
          const asked = (await visible(consent)) ? await consent.getByRole('heading').first().innerText({ timeout: 3000 }).catch(() => null) : null;
          if (asked) {
            approved.push(asked.trim());
            await shot(`consent-${approved.length}`);
            keepProposals(approved.length);
            await tap(consent.getByRole('button', { name: 'Set up', exact: true }));
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
        await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
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
    if (part !== 'activity') await step('example-run', exampleRun);
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
      await step('run-with-input', runWithInput);
      await step('wrong-check', async () => {
        await wrongAnswer(1);
        const verdict = await check();
        return `${verdict}; live: ${livePhases.join(', ') || 'none seen'}`;
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
          const offered: string[] = [];
          if ((await toMap()) === 'welcome') {
            await shot(`switch-to-${switchTo}-welcome`);
            offered.push('the welcome screen, Connect an agent');
          } else {
            await page.getByRole('button', { name: 'Continue', exact: true }).click();
          }
          if (!offered.length) await until('the connect screen', async () => {
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
          // Come back later shows only when another topic is ready (§4.4); otherwise keep trying.
          if (await visible(button('Come back later'))) {
            await button('Come back later').click();
            await toMap();
            return 'came back later';
          }
          await shot('stuck-no-later');
          await button('Keep trying').click();
          await toMap();
          return 'no other topic ready: Come back later not offered, kept trying';
        });
      }
      await step('progress', async () => {
        await toMap();
        return (await page.getByRole('list', { name: 'Topics' }).getByRole('img').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).join(', ');
      });
      await step('review-scheduled', async () => {
        await toMap();
        const mastery = page.getByRole('complementary').filter({ has: heading('Mastery') });
        const text = (await visible(mastery)) ? (await mastery.innerText()).replace(/\s+/g, ' ') : (await page.locator('main').innerText()).replace(/\s+/g, ' ');
        const due = button('Review');
        if (await visible(due)) {
          await shot('review-due');
          await due.first().click();
          await until('the review', () => visible(button('Check')), 15 * MIN);
          await rightAnswer();
          return `review due and done: ${await check()}`;
        }
        await shot('review-scheduled');
        return (text.match(/Review (tomorrow|in \d+ days)/g) ?? ['no review shown']).join(', ');
      });
      await step('usage', async () => {
        await toMap();
        const usage = page.getByRole('region', { name: 'Usage' });
        if (!(await visible(usage))) return 'no usage shown';
        await shot('usage');
        return (await usage.innerText()).replace(/\s+/g, ' ');
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
            await page.getByRole('textbox', { name: 'What you already know (optional)' }).fill('HTML and JavaScript');
            await button('Start').click();
            await until('the new suggested path', () => visible(button('Approve')), 15 * MIN);
            return `${await page.getByRole('button', { name: /^Rename / }).count()} topics for React`;
          });
        }
      }
    }
  }

  if (walkTimer) clearInterval(walkTimer);
  await app.close();
  // Isolation: the run used its own folders only. Anything that wrote to the real ones is a bug.
  expect(snapshot(), "the run changed the learner's real Codemm data, profile or log").toEqual(untouched);
});
