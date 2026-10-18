import { _electron as electron, expect, test } from '@playwright/test';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './temp';

// Launches the built app with the mock (CODEMM_MOCK) and walks the main journey.
test('connect, computer check, goal, course, lesson and practice', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const heading = (name: string) => page.getByRole('heading', { name, exact: true });

  await button('Connect an agent').click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await button('Continue').click();
  await expect(heading('Check this computer')).toBeVisible();
  await expect(page.getByText('This computer is ready.')).toBeVisible();
  await button('Continue').click();
  await button('Start learning').click();

  await page.getByRole('textbox', { name: 'What do you want to learn?' }).fill('React');
  await page.getByRole('textbox', { name: 'I already know' }).fill('Python');
  await button('Start').click();
  await expect(heading('Researching React')).toBeVisible();

  await expect(button('Approve')).toBeVisible({ timeout: 15_000 });
  await button('Approve').click();
  const consent = page.getByRole('dialog', { name: 'Set up React on this computer?' });
  await consent.getByRole('button', { name: 'Set up', exact: true }).click();

  await expect(heading('JavaScript basics')).toBeVisible();
  await expect(button('Read useState')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Setting up React/)).toBeHidden({ timeout: 15_000 });
  await button('Read What javascript basics is').click();
  await button('Next').click();
  await expect(heading('useState')).toBeVisible();
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

// Learners who lack a prerequisite get a specific next step, acted out by the mock.
test('no agent installed: install links on the connect screen', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: 'no-agent' } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  const claude = page.getByRole('listitem', { name: 'Claude Code' });
  await expect(claude.getByText('Not installed')).toBeVisible();
  await expect(claude.getByRole('link', { name: 'Get Claude Code' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
  await expect(page.getByRole('link', { name: 'Get Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await app.close();
});

test('no Docker: Install Docker, a link to do it by hand, and a re-check', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: 'no-docker' } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  await page.getByRole('listitem', { name: 'Claude Code' }).getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const installed = page.getByRole('listitem', { name: 'Docker is installed' });
  await expect(installed.getByText('Needs a step')).toBeVisible();
  // macOS and Windows: Codemm installs Docker, and doing it by hand stays possible.
  await expect(installed.getByRole('button', { name: 'Install Docker', exact: true })).toBeVisible();
  await expect(installed.getByRole('link', { name: 'Install it myself' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText("Docker isn't installed yet. Checking again every few seconds.");
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await app.close();
});

// D2: the window is the app's own origin under the spec's CSP, with no Node, no remote requests,
// no frames, no navigation and no new windows.
test('renderer security', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible();
  expect(page.url()).toBe('app://codemm/index.html');
  expect(await page.evaluate(() => [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process])).toEqual(['undefined', 'undefined']);

  // A request CSP blocks still shows as a request; it must fail as blocked and get no response.
  const responses: string[] = [];
  const failures: string[] = [];
  page.on('response', (r) => r.url().startsWith('app:') || responses.push(r.url()));
  page.on('requestfailed', (r) => failures.push(r.failure()?.errorText ?? ''));
  const blocked = await page.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
    const img = Object.assign(document.createElement('img'), { src: 'https://example.com/pixel.png' });
    const frame = Object.assign(document.createElement('iframe'), { src: 'https://example.com/' });
    const style = Object.assign(document.createElement('style'), { textContent: 'body { color: red; }' });
    document.body.append(img, frame);
    document.head.append(style);
    await new Promise((r) => setTimeout(r, 500));
    return seen.sort();
  });
  expect(blocked).toEqual(expect.arrayContaining(['frame-src', 'img-src', 'style-src-elem']));
  expect(responses).toEqual([]);
  expect(failures.every((f) => f === 'csp')).toBe(true);

  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true);
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  // The navigation was cancelled: the same document still shows the app.
  expect(await page.evaluate(() => [location.href, document.body.innerText.includes('Connect an agent')])).toEqual(['app://codemm/index.html', true]);
  await app.close();
});

// N3: a rejected call reaches the renderer as Codemm's own message, without Electron's
// "Error invoking remote method" envelope, so codes like codemm:repair still match.
test('errors cross IPC as their own message', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible();
  const messages = await page.evaluate(async () => {
    const bridge = (window as unknown as { codemm: { invoke(m: string, a: unknown[]): Promise<unknown> } }).codemm;
    const call = (method: string, args: unknown[]) => bridge.invoke(method, args).then(() => 'resolved', (e: Error) => e.message);
    return [await call('nope', []), await call('lesson', [42])];
  });
  expect(messages).toEqual(['Unknown call', 'Bad input']);
  await app.close();
});

// A separate profile (--user-data-dir) keeps its log too, so runs with one never write to the learner's log.
test('logs live under a given user-data-dir', async () => {
  const dir = realpathSync(tempDir('codemm-profile-'));
  const app = await electron.launch({ args: ['.', `--user-data-dir=${dir}`], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible();
  expect(await app.evaluate(({ app: a }) => a.getPath('logs'))).toBe(join(dir, 'logs'));
  await app.close();
  expect(readFileSync(join(dir, 'logs', 'codemm.log'), 'utf8')).toContain(' start ');
});

// Check progress: main sends it to the app window, the preload hands the page only a phase and counts,
// and the renderer can't call it as a method.
test('check progress reaches the page as phase and counts only', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: '' } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible();
  const { events, asCall } = await page.evaluate(async () => {
    type P = { phase: string; done: number; total: number };
    const bridge = (window as unknown as { codemm: { invoke(m: string, a: unknown[]): Promise<any>; onCheckProgress(l: (p: P) => void): () => void } }).codemm;
    const events: P[] = [];
    const stop = bridge.onCheckProgress((p) => events.push(p));
    const call = (m: string, ...a: unknown[]) => bridge.invoke(m, a);
    await call('connect', 'claude');
    const goal = { topic: 'React', known: '', depth: 'standard' };
    let r = await call('research', goal);
    while (r.state === 'running') r = await call('research', goal);
    await call('approve', r.roadmap.concepts);
    let c = await call('course');
    while (c.setup !== 'consent') c = await call('course');
    await call('install', c.proposal.digest);
    while (!(c.setup === 'ready' && c.topics[0].lessons.every((l: { state: string }) => l.state !== 'writing'))) c = await call('course');
    for (const l of c.topics[0].lessons) await call('markRead', l.id);
    const { id } = await call('activity', c.topics[0].id);
    await call('check', id, 'e2e-run');
    // Events travel apart from the call's reply, so the last ones can land just after it.
    await new Promise((r) => setTimeout(r, 300));
    stop();
    const asCall = await bridge.invoke('onCheckProgress', []).then(() => 'resolved', (e: Error) => e.message);
    return { events, asCall };
  });
  expect(events.at(-1)).toEqual({ run: 'e2e-run', phase: 'hidden', done: 0, total: 0 });
  for (const e of events) expect(Object.keys(e).sort()).toEqual(['done', 'phase', 'run', 'total']);
  expect(asCall).toBe('Unknown call');
  await app.close();
});

// Run: main sends a program's output only to the window that started it; the page hears it tagged with its run,
// types into it, and can't call onRunOutput as a method.
test('Run streams a program through the bridge, with typed input', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, CODEMM_MOCK: 'io-track' } });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Connect an agent', exact: true })).toBeVisible();
  const { events, result, asCall } = await page.evaluate(async () => {
    type O = Record<string, unknown>;
    const bridge = (window as unknown as { codemm: { invoke(m: string, a: unknown[]): Promise<any>; onRunOutput(l: (o: O) => void): () => void } }).codemm;
    const call = (m: string, ...a: unknown[]) => bridge.invoke(m, a);
    await call('connect', 'claude');
    const goal = { topic: 'Python', known: '', depth: 'standard' };
    let r = await call('research', goal);
    while (r.state === 'running') r = await call('research', goal);
    await call('approve', r.roadmap.concepts);
    let c = await call('course');
    while (c.setup !== 'consent') c = await call('course');
    await call('install', c.proposal.digest);
    while (!(c.setup === 'ready' && c.topics[0].lessons.every((l: { state: string }) => l.state !== 'writing'))) c = await call('course');
    for (const l of c.topics[0].lessons) await call('markRead', l.id);
    const { id } = await call('activity', c.topics[0].id);
    const events: O[] = [];
    const heard = new Promise<void>((resolve) => bridge.onRunOutput((o) => (events.push(o), events.length === 2 && resolve())));
    const running = call('runProgram', id, 'e2e-run');
    await heard;
    const taken = await call('sendRunInput', 'e2e-run', 'Ada\n');
    const result = await running;
    await new Promise((r) => setTimeout(r, 300));
    const asCall = await bridge.invoke('onRunOutput', []).then(() => 'resolved', (e: Error) => e.message);
    return { events, result: { ...result, taken }, asCall };
  });
  expect(events).toEqual([
    { run: 'e2e-run', started: 'run', limitMs: 120_000 },
    { run: 'e2e-run', stream: 'stdout', text: "What's your name? " },
    { run: 'e2e-run', stream: 'stdout', text: 'Hello, Ada!\n' },
  ]);
  expect(result).toMatchObject({ kind: 'ran', exit: 0, taken: true });
  expect(asCall).toBe('Unknown call');
  await app.close();
});
