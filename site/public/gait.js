// Emm's gait, as pure functions. A chameleon steps in diagonal pairs (front-left
// with back-right), and a planted foot stays put: the gait's phase advances with
// the distance covered, one cycle per stride, so a foot on the ground moves back
// exactly as fast as the body moves forward. Lengths are in Emm's SVG units.

export const DUTY = 0.55; // the share of a stride each foot spends on the ground
export const NEUTRAL = DUTY / 2; // the phase at which every foot is under its hip

/**
 * Distance s covered and speed v at time t (ms) of a run of `distance` that eases
 * in over `ease` ms, holds `speed`, and eases out to a stop. A run too short to
 * reach `speed` peaks lower.
 */
export function travel(t, distance, speed, ease) {
  if (!(distance > 0)) return { s: 0, v: 0, done: true };
  const top = Math.min(speed, distance / ease); // easing in and out covers top * ease
  const cruise = (distance - top * ease) / top;
  const end = 2 * ease + cruise;
  // Easing in: speed follows half a cosine from 0 to top.
  const ramp = (x) => ({ s: top * (x / 2 - (ease / (2 * Math.PI)) * Math.sin((Math.PI * x) / ease)), v: (top * (1 - Math.cos((Math.PI * x) / ease))) / 2 });
  if (t >= end) return { s: distance, v: 0, done: true };
  if (t < ease) return { ...ramp(Math.max(0, t)), done: false };
  if (t < ease + cruise) return { s: (top * ease) / 2 + top * (t - ease), v: top, done: false };
  const out = ramp(end - t); // easing out mirrors easing in
  return { s: distance - out.s, v: out.v, done: false };
}

/**
 * A foot at phase p of a stride: u, how far ahead of its resting spot it is, and
 * lift, 0 on the ground to 1 at the top of its swing. At phase 0 it touches down
 * at the front of its step; it pushes back until DUTY, then lifts and swings forward.
 */
export function foot(p, stride) {
  p -= Math.floor(p);
  const step = stride * DUTY;
  if (p < DUTY) return { u: step / 2 - stride * p, lift: 0 };
  const s = (p - DUTY) / (1 - DUTY);
  return { u: step * (s - Math.sin(2 * Math.PI * s) / (2 * Math.PI) - 0.5), lift: Math.sin(Math.PI * s) };
}

/**
 * The stride nearest `nominal` that ends a run of `distance`, started at phase
 * `from`, at a neutral phase, so Emm stops standing square instead of mid-step.
 */
export function strideFor(distance, from, nominal) {
  const needed = ((((NEUTRAL - from) % 0.5) + 0.5) % 0.5) || 0.5; // phase to the next neutral pose
  const halves = Math.max(0, Math.round((distance / nominal - needed) * 2));
  return distance / (needed + halves / 2);
}

/**
 * The body at phase p, moving at w (0 standing, 1 full speed): it dips a little
 * each step, rocks once a stride, and the tail and the chip on its back follow
 * a beat late. Lengths in SVG units, angles in degrees.
 */
export function body(p, w) {
  const a = 2 * Math.PI * (p - NEUTRAL);
  const late = 0.6; // radians behind the body
  return {
    bob: (2.2 * w * (1 - Math.cos(2 * a))) / 2,
    rock: 1.6 * w * Math.sin(a),
    tail: -5 * w * Math.sin(a - late),
    curl: 0.035 * w * Math.sin(2 * a - late),
    chip: 3.5 * w * Math.sin(2 * a - 2 * late),
  };
}
