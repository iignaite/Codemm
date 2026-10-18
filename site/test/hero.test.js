import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A minimal page for public/hero.js: the walking scene, three agents, and a
// reduced-motion preference. Every element records the animations it starts.
function element() {
  const el = {
    animations: [],
    listeners: {},
    dataset: {},
    hidden: false,
    offsetWidth: 80,
    offsetHeight: 40,
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: { toggle() {} },
    animate(...args) { el.animations.push(args); },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
  };
  return el;
}

async function loadWith({ reduced, frames = [] }) {
  const stage = element();
  const parts = { '.walk-scene': element(), '.emm': element(), '.tongue': element(), '.motion': element() };
  const agents = [element(), element(), element()];
  stage.querySelector = (q) => parts[q];
  stage.querySelectorAll = (q) => (q === '.agent' ? agents : []);
  Object.assign(globalThis, {
    document: { querySelector: (q) => (q === '.walk' ? stage : null), hidden: false },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    requestAnimationFrame: (fn) => frames.push(fn),
    IntersectionObserver: class { observe() {} },
    addEventListener() {},
    getComputedStyle: () => ({ boxShadow: 'none' }),
  });
  await import(`../public/hero.js?${Math.random()}`);
  return { stage, parts, agents };
}

test('with reduced motion, clicking an agent changes Emm\'s colors and starts no animation', async () => {
  const { stage, parts, agents } = await loadWith({ reduced: true });
  for (const fn of agents[1].listeners.click) fn();
  assert.equal(stage.style.props['--emm-b'], '#7383F7');
  const started = [stage, ...Object.values(parts), ...agents].flatMap((el) => el.animations);
  assert.deepEqual(started, []);
});

test('Emm wakes, catches and eats the first agent within three seconds', async () => {
  const frames = [];
  const { stage } = await loadWith({ reduced: false, frames });
  // Runs the page's frames, 16 ms apart, until three seconds have passed.
  for (let now = performance.now(), end = now + 3000; now < end && frames.length; now += 16) frames.shift()(now);
  // Eating Claude Code turns Emm its color.
  assert.equal(stage.style.props['--emm-b'], '#E8875F');
});

test("Emm carries Codemm's mark on its back", () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const emm = html.match(/<svg class="emm"[\s\S]*?<\/svg>/)[0];
  assert.match(emm, /<g class="mark"[\s\S]*?<polyline [^>]*points="[^"]+"/);
});
