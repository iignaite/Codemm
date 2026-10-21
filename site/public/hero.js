// The hero: Emm runs to Claude Code, Codex and Cursor in turn, the view following
// it, so each agent comes in from the right. Emm eases to a stop in reach, catches
// the agent with its tongue, eats it and takes its color. Clicking the agent ahead
// makes Emm catch it at once. It has a pause button, stops offscreen and in hidden
// tabs, and with reduced motion nothing moves: Emm stands, the agents stand still,
// and clicking one just changes Emm's color.
import { NEUTRAL, body, foot, strideFor, travel } from './gait.js';

const stage = document.querySelector('.walk');

if (stage) {
  const scene = stage.querySelector('.walk-scene');
  const emm = stage.querySelector('.emm');
  const tongue = stage.querySelector('.tongue');
  const agents = [...stage.querySelectorAll('.agent')];
  const toggle = stage.querySelector('.motion');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // Emm, a chameleon, takes the color of the agent it eats: body, dark, belly, stripes.
  const COLORS = [
    ['#E8875F', '#C1613A', '#F8D3C2', '#D97757'], // Claude Code
    ['#7383F7', '#4A57DB', '#D6DBFD', '#5F6EF0'], // Codex
    ['#636B7A', '#3B414D', '#CDD2DB', '#4F5664'], // Cursor
  ];
  const START_MS = 800; // Emm wakes first
  const SPEED = 0.12; // Emm's top speed, in its SVG's units per ms (it's 200 units long)
  const EASE_MS = 450; // to get up to speed, and to stop
  const STRIDE = 36; // SVG units a foot covers in one cycle
  const LIFT = 5; // how high a swinging foot rises, in SVG units
  const STRIKE_MS = 110;
  const PULL_MS = 220;
  const REST_MS = 450;

  // Emm's parts. Each leg is drawn from hip to foot, standing; a run moves the foot
  // along the ground and the hip with the body. leg-a and leg-b are the diagonal pairs.
  const part = (q) => emm.querySelector(q);
  const torso = part('.torso');
  const tail = part('.tail');
  const head = part('.head');
  const chip = part('.chip');
  const pupil = part('.pupil');
  const legs = [...emm.querySelectorAll('.leg')].map((el) => {
    const [hx, hy, fx, fy] = el.getAttribute('d').match(/-?[\d.]+/g).map(Number);
    return { el, hx, hy, fx, fy, d: el.getAttribute('d'), pair: el.classList.contains('leg-b') ? 0.5 : 0 };
  });

  let paused = false;
  let visible = true;
  let clock = 0; // advances only while moving
  let last = performance.now();
  let current = 0;
  let phase = 'wait';
  let since = 0;
  let run = { from: NEUTRAL, distance: 0 }; // the current run, in SVG units
  let gait = NEUTRAL; // leg-a's phase in its stride; leg-b is half a stride on
  let stride = STRIDE;
  let effort = 0; // 0 standing to 1 at full speed, eased
  let look = 0; // 0 looking ahead to 1 at the agent, eased

  const moving = () => !reduce.matches && !paused && visible && !document.hidden;

  function takeColor(i) {
    const [b, d, be, st] = COLORS[i];
    stage.style.setProperty('--emm-b', b);
    stage.style.setProperty('--emm-d', d);
    stage.style.setProperty('--emm-be', be);
    stage.style.setProperty('--emm-s', st);
    if (reduce.matches) return; // the color changes, but nothing moves
    emm.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08, .94)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' });
  }

  /** Positions in the scene: Emm's mouth, the ground, an agent's size. */
  function geometry() {
    const s = scene.getBoundingClientRect();
    const e = emm.getBoundingClientRect();
    // Agents share one size; measure a visible one (a hidden button measures 0).
    const size = (agents.find((a) => !a.hidden) ?? agents[0]).offsetWidth;
    return {
      width: s.width,
      size,
      mouthX: e.left - s.left + e.width * 0.95,
      mouthY: e.top - s.top + e.height * (108 / 170),
      groundY: s.height * 0.78,
      scale: e.width / 200, // pixels per SVG unit
    };
  }

  /** Draws Emm at a gait phase and effort. The head moves less than the body. */
  function pose(p, w) {
    const b = body(p, w);
    const lean = `translate(0 ${b.bob}) rotate(${b.rock} 98 112)`;
    torso.setAttribute('transform', lean);
    chip.setAttribute('transform', `rotate(${b.chip} 89 80)`);
    tail.setAttribute('transform', `${lean} rotate(${b.tail} 60 108) translate(60 108) scale(${1 + b.curl}) translate(-60 -108)`);
    head.setAttribute('transform', `translate(0 ${b.bob * 0.35}) rotate(${b.rock * 0.3} 126 104)`);
    pupil.setAttribute('transform', `translate(${1.5 * look} ${2.5 * look})`);
    const turn = (b.rock * Math.PI) / 180;
    for (const leg of legs) {
      const f = foot(p + leg.pair, stride);
      const hx = 98 + (leg.hx - 98) * Math.cos(turn) - (leg.hy - 112) * Math.sin(turn);
      const hy = 112 + (leg.hx - 98) * Math.sin(turn) + (leg.hy - 112) * Math.cos(turn) + b.bob;
      const n = (v) => v.toFixed(2);
      leg.el.setAttribute('d', `M${n(hx)} ${n(hy)} L${n(leg.fx + f.u)} ${n(leg.fy - LIFT * f.lift * Math.min(1, w * 3))}`);
    }
  }

  /** Emm as the page draws it, standing. */
  function stand() {
    for (const el of [torso, tail, head, chip, pupil]) el.removeAttribute('transform');
    for (const leg of legs) leg.el.setAttribute('d', leg.d);
  }

  function place(el, x, y, scale = 1, opacity = 1, tilt = 0) {
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${tilt}deg) scale(${scale})`;
    el.style.opacity = String(opacity);
  }

  function show(i) {
    agents.forEach((el, j) => {
      el.hidden = j !== i;
      if (j !== i) place(el, -999, 0, 1, 0);
    });
  }

  /** With reduced motion: the three agents stand in a row, and Emm stays put. */
  function still() {
    tongue.hidden = true;
    stand();
    agents.forEach((el) => { el.hidden = false; });
    const g = geometry();
    agents.forEach((el, i) => {
      place(el, g.width * (0.5 + i * 0.165), g.groundY - g.size);
    });
  }

  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    if (reduce.matches) return still();
    const step = moving() ? dt : 0;
    clock += step;
    const g = geometry();
    const el = agents[current];
    const startX = g.width + g.size * 0.2;
    const reachX = g.mouthX + g.width * 0.2;
    const t = clock - since;
    let speed = 0; // a share of the top speed

    if (phase === 'wait') {
      tongue.hidden = true;
      if (clock >= START_MS) startRun(Math.max(0, startX - reachX) / g.scale);
    } else if (phase === 'run') {
      // The agent stands on the ground, so it comes toward Emm as fast as Emm runs.
      const r = travel(t, run.distance, SPEED, EASE_MS);
      gait = run.from + r.s / stride;
      speed = r.v / SPEED;
      place(el, startX - r.s * g.scale, g.groundY - g.size);
      if (r.done) { phase = 'strike'; since = clock; }
    } else if (phase === 'strike' || phase === 'pull') {
      tongue.hidden = false;
      const q = Math.min(1, t / (phase === 'strike' ? STRIKE_MS : PULL_MS));
      const full = reachX + g.size * 0.15 - g.mouthX;
      const length = phase === 'strike' ? full * q : full * (1 - q);
      tongue.style.width = `${length}px`;
      tongue.style.transform = `translate3d(${g.mouthX}px, ${g.mouthY - 4}px, 0)`;
      if (phase === 'pull') {
        const scale = 1 - 0.7 * q;
        const size = g.size * scale;
        const y = (g.groundY - g.size) + ((g.mouthY - size / 2) - (g.groundY - g.size)) * q;
        place(el, g.mouthX + length - size * 0.3, y, scale, 1 - 0.6 * q);
      }
      if (q >= 1 && phase === 'strike') { phase = 'pull'; since = clock; }
      else if (q >= 1) {
        tongue.hidden = true;
        place(el, -999, 0, 1, 0);
        takeColor(current);
        phase = 'rest'; since = clock;
      }
    } else if (phase === 'rest' && t >= REST_MS) {
      current = (current + 1) % agents.length;
      startRun(Math.max(0, startX - reachX) / g.scale);
    }
    // Emm glances at the agent as it slows down for it, and looks ahead again after eating.
    const glance = (phase === 'run' && t > EASE_MS && speed < 0.95) || phase === 'strike' || phase === 'pull';
    if (step) {
      effort += (speed - effort) * Math.min(1, step / 90);
      look += ((glance ? 1 : 0) - look) * Math.min(1, step / 60);
    }
    if (phase !== 'wait') pose(gait, effort);
    requestAnimationFrame(frame);
  }

  /** Starts a run of `distance` SVG units to the next agent, from where Emm's legs are. */
  function startRun(distance) {
    gait -= Math.floor(gait);
    run = { from: gait, distance };
    stride = strideFor(distance, gait, STRIDE);
    phase = 'run'; since = clock;
    show(current);
  }

  // A click on the agent ahead: Emm stops and catches it now. With reduced motion: just its color.
  agents.forEach((el, i) => el.addEventListener('click', () => {
    if (reduce.matches) return takeColor(i);
    if (i === current && phase === 'run') { phase = 'strike'; since = clock; }
  }));

  function setPaused(value) {
    paused = value;
    stage.classList.toggle('paused', paused);
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
  }
  toggle.addEventListener('click', () => setPaused(!paused));

  const showToggle = () => { toggle.hidden = reduce.matches; };
  showToggle();
  reduce.addEventListener('change', () => { showToggle(); last = performance.now(); requestAnimationFrame(frame); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(stage);
  addEventListener('resize', () => { if (reduce.matches) still(); });

  requestAnimationFrame(frame);
}
