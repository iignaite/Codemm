import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUTY, NEUTRAL, body, foot, strideFor, travel } from '../public/gait.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('a run eases in from standing, holds its speed, and eases out to a stop at the distance', () => {
  const run = (t) => travel(t, 200, 0.1, 400);
  near(run(0).s, 0);
  near(run(0).v, 0);
  near(run(1000).v, 0.1); // cruising
  const end = 400 + 200 / 0.1; // two half-ramps of easing cost one ramp at full speed
  near(run(end).s, 200);
  near(run(end).v, 0);
  assert.equal(run(end).done, true);
  assert.equal(run(end - 1).done, false);
  // Never backwards, and no jumps in speed.
  for (let t = 0, prev = run(0); t <= end; t += 5) {
    const now = run(t);
    assert.ok(now.s >= prev.s - 1e-9);
    assert.ok(Math.abs(now.v - prev.v) < 0.01);
    prev = now;
  }
});

test('a run too short to reach full speed still eases in and out', () => {
  const run = (t) => travel(t, 20, 0.1, 400);
  near(run(0).v, 0);
  assert.ok(run(400).v < 0.1);
  near(run(800).s, 20);
  assert.equal(run(800).done, true);
});

test('a run of no distance is over at once', () => {
  assert.deepEqual(travel(0, 0, 0.1, 400), { s: 0, v: 0, done: true });
});

test('a planted foot stays put on the ground while the body moves over it', () => {
  const stride = 40;
  // Gait phase advances by distance / stride, so a foot planted on the ground moves
  // back exactly as fast as the body moves forward.
  const world = (p) => foot(p, stride).u + p * stride;
  for (let p = 0; p < DUTY; p += 0.01) {
    near(world(p), world(0));
    assert.equal(foot(p, stride).lift, 0);
  }
});

test('a swinging foot lifts, swings forward, and lands where the next step starts', () => {
  const stride = 40;
  const step = stride * DUTY;
  near(foot(DUTY, stride).u, -step / 2);
  assert.ok(foot((DUTY + 1) / 2, stride).lift > 0.99);
  near(foot(1 - 1e-9, stride).u, step / 2, 1e-6);
  near(foot(1 - 1e-9, stride).lift, 0, 1e-6);
});

test('at the neutral phase both diagonal pairs stand under their hips', () => {
  near(foot(NEUTRAL, 40).u, 0);
  near(foot(NEUTRAL + 0.5, 40).u, 0);
});

test('the stride is fitted so a run ends with Emm standing square', () => {
  for (const from of [NEUTRAL, 0, 0.4, 0.9]) {
    for (const distance of [60, 169, 300]) {
      const stride = strideFor(distance, from, 36);
      // Ends a whole number of half strides past the neutral phase.
      const halves = (from + distance / stride - NEUTRAL) * 2;
      near(halves, Math.round(halves));
      assert.ok(stride > 36 * 0.7 && stride < 36 * 1.5, `stride ${stride} for ${distance} from ${from}`);
    }
  }
});

test('standing, the body is at rest; moving, it bobs, rocks and the tail lags', () => {
  for (const value of Object.values(body(0.3, 0))) near(value, 0);
  near(body(NEUTRAL, 1).bob, 0);
  const moving = [0, 0.1, 0.2, 0.3, 0.4].map((p) => body(p, 1));
  assert.ok(moving.some((b) => b.bob > 0.5));
  assert.ok(moving.some((b) => Math.abs(b.rock) > 0.5));
  assert.ok(moving.some((b) => Math.abs(b.tail) > 0.5));
});
