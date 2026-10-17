import { extractFile, listPackage } from '@electron/asar';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// #14: the installer carries no development mock or demo curriculum. Reads the
// packaged app named by CODEMM_RESOURCES (set by CI after `npm run dist`).
const resources = process.env.CODEMM_RESOURCES;
// Strings only the mock (src/main/mock.ts) contains: its scenario switch and its demo React course.
// (main.js may still name the mock in its development-only branch; that loads nothing when packaged.)
const DEMO = /Unknown mock scenario|Click Counter|Counter\.jsx/;

test('the packaged app carries no mock or demo curriculum', () => {
  test.skip(!resources, 'needs CODEMM_RESOURCES');
  const asar = join(resources!, 'app.asar');
  const files = listPackage(asar, { isPack: false }).map((f) => f.replaceAll('\\', '/').replace(/^\//, ''));
  expect(files).toContain('out/main/main.js');
  expect(files.filter((f) => /mock/i.test(f))).toEqual([]);
  const scripts = files.filter((f) => f.endsWith('.js')).map((f) => [f, extractFile(asar, f).toString('utf8')] as const);
  const core = readdirSync(join(resources!, 'core'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => [`core/${f}`, readFileSync(join(resources!, 'core', f), 'utf8')] as const);
  expect([...scripts, ...core].filter(([, text]) => DEMO.test(text)).map(([f]) => f)).toEqual([]);
});
