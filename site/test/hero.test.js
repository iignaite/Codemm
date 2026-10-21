import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A minimal page for public/hero.js: the walking scene, Emm's parts, three agents,
// and a reduced-motion preference. Every element records the animations it starts.
function element(attrs = {}, classes = [], rect = { left: 0, top: 0, width: 400, height: 320 }) {
  const el = {
    animations: [],
    listeners: {},
    dataset: {},
    attrs: { ...attrs },
    hidden: false,
    offsetWidth: 80,
    offsetHeight: 40,
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: { toggle() {}, contains: (c) => classes.includes(c) },
    animate(...args) { el.animations.push(args); },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    getAttribute: (k) => el.attrs[k] ?? null,
    getBoundingClientRect: () => rect,
  };
  return el;
}

// Emm's legs as the page draws them: hip to foot, in diagonal pairs.
const LEGS = [['M82 124 L 77 150', 'leg-a'], ['M120 126 L 125 150', 'leg-b'], ['M140 122 L 145 150', 'leg-a'], ['M96 130 L 92 150', 'leg-b']];

async function loadWith({ reduced, frames = [] }) {
  const stage = element();
  const emm = element({}, [], { left: 16, top: 120, width: 176, height: 150 });
  const legs = LEGS.map(([d, pair]) => element({ d }, ['leg', pair]));
  const body = Object.fromEntries(['.torso', '.tail', '.head', '.chip', '.pupil'].map((q) => [q, element()]));
  emm.querySelector = (q) => body[q];
  emm.querySelectorAll = (q) => (q === '.leg' ? legs : []);
  const parts = { '.walk-scene': element(), '.emm': emm, '.tongue': element(), '.motion': element() };
  const agents = [element(), element(), element()];
  const media = { matches: reduced, change: [], addEventListener(_, fn) { this.change.push(fn); } };
  stage.querySelector = (q) => parts[q];
  stage.querySelectorAll = (q) => (q === '.agent' ? agents : []);
  Object.assign(globalThis, {
    document: { querySelector: (q) => (q === '.walk' ? stage : null), hidden: false },
    matchMedia: () => media,
    requestAnimationFrame: (fn) => frames.push(fn),
    IntersectionObserver: class { observe() {} },
    addEventListener() {},
    getComputedStyle: () => ({ boxShadow: 'none' }),
  });
  await import(`../public/hero.js?${Math.random()}`);
  return { stage, parts, agents, legs, body, media };
}

// Runs the page's frames, 16 ms apart, for the given time.
function play(frames, ms, from = { now: performance.now() }) {
  for (const end = from.now + ms; from.now < end && frames.length; from.now += 16) frames.shift()(from.now);
  return from;
}

// Every foot back where the page draws it standing.
function assertSquare(legs) {
  const feet = (ds) => ds.map((d) => d.match(/-?[\d.]+/g).slice(2).map(Number));
  const drawn = feet(LEGS.map(([d]) => d));
  feet(legs.map((l) => l.attrs.d)).forEach(([x, y], i) => {
    assert.ok(Math.abs(x - drawn[i][0]) < 0.05 && Math.abs(y - drawn[i][1]) < 0.1, `foot ${i} at ${x},${y}`);
  });
}

// What a viewer sees of Emm and the agents.
const snapshot = ({ legs, body, agents }) => JSON.stringify([legs.map((l) => l.attrs), Object.values(body).map((b) => b.attrs), agents.map((a) => a.style.transform)]);

test('with reduced motion, clicking an agent changes Emm\'s colors and starts no animation', async () => {
  const { stage, parts, agents } = await loadWith({ reduced: true });
  for (const fn of agents[1].listeners.click) fn();
  assert.equal(stage.style.props['--emm-b'], '#7383F7');
  const started = [stage, ...Object.values(parts), ...agents].flatMap((el) => el.animations);
  assert.deepEqual(started, []);
});

test('turning on reduced motion mid-run stands Emm still, and turning it off keeps one agent on stage', async () => {
  const frames = [];
  const page = await loadWith({ reduced: false, frames });
  const clock = play(frames, 1600); // mid-run
  page.media.matches = true;
  page.media.change.forEach((fn) => fn());
  play(frames, 500, clock);
  assert.deepEqual(page.legs.map((l) => l.attrs.d), LEGS.map(([d]) => d));
  for (const part of Object.values(page.body)) assert.equal(part.attrs.transform, undefined);
  assert.equal(frames.length, 0); // and no frame loop keeps running
  page.media.matches = false;
  page.media.change.forEach((fn) => fn());
  assert.deepEqual(page.agents.map((a) => a.hidden), [false, true, true]);
});

test('Emm wakes, runs to the first agent, and catches and eats it within three and a half seconds', async () => {
  const frames = [];
  const { stage } = await loadWith({ reduced: false, frames });
  play(frames, 3500);
  // Eating Claude Code turns Emm its color.
  assert.equal(stage.style.props['--emm-b'], '#E8875F');
});

test('Emm runs on its legs: they step while it runs and stand square once it has stopped to eat', async () => {
  const frames = [];
  const page = await loadWith({ reduced: false, frames });
  const tongue = page.parts['.tongue'];
  const clock = play(frames, 1600); // mid-run
  assert.notDeepEqual(page.legs.map((l) => l.attrs.d), LEGS.map(([d]) => d));
  while (tongue.hidden) play(frames, 16, clock); // runs until it stops and strikes
  while (!tongue.hidden) play(frames, 16, clock); // eats
  play(frames, 300, clock); // rests
  assertSquare(page.legs);
});

test('clicked mid-stride, Emm catches the agent and then stands square', async () => {
  for (const ms of [1000, 1300, 1600, 1900]) {
    const frames = [];
    const page = await loadWith({ reduced: false, frames });
    const clock = play(frames, ms);
    page.agents[0].listeners.click[0]();
    play(frames, 16, clock);
    assert.equal(page.parts['.tongue'].hidden, false);
    play(frames, 700, clock); // eats and rests
    assertSquare(page.legs);
  }
});

test('the pause button freezes Emm and the agent mid-run, and play resumes', async () => {
  const frames = [];
  const page = await loadWith({ reduced: false, frames });
  const toggle = page.parts['.motion'];
  const clock = play(frames, 1600);
  toggle.listeners.click[0]();
  play(frames, 32, clock); // the frame after the click
  const paused = snapshot(page);
  play(frames, 1000, clock);
  assert.equal(snapshot(page), paused);
  toggle.listeners.click[0]();
  play(frames, 200, clock);
  assert.notEqual(snapshot(page), paused);
});

test("Emm carries Codemm's mark on its back", () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const emm = html.match(/<svg class="emm"[\s\S]*?<\/svg>/)[0];
  assert.match(emm, /<g class="mark"[\s\S]*?<polyline [^>]*points="[^"]+"/);
});
