// The hero: Emm walks along, and Claude Code, Codex and Cursor walk in one at a
// time. When one comes close, Emm catches it with its tongue, eats it and takes
// its color. Clicking a walking agent makes Emm catch it at once. It has a pause
// button, stops offscreen and in hidden tabs, and with reduced motion nothing
// moves: the agents stand still, and clicking one just changes Emm's color.
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
  const WALK_MS = 1600;
  const STRIKE_MS = 110;
  const PULL_MS = 220;
  const REST_MS = 450;

  let paused = false;
  let visible = true;
  let clock = 0; // advances only while moving
  let last = performance.now();
  let current = 0;
  let phase = 'wait';
  let since = 0;

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
    };
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
    if (moving()) clock += dt;
    const g = geometry();
    const el = agents[current];
    const startX = g.width + g.size * 0.2;
    const reachX = g.mouthX + g.width * 0.2;
    const t = clock - since;

    if (phase === 'wait') {
      tongue.hidden = true;
      if (clock >= START_MS) { phase = 'walk'; since = clock; show(current); }
    } else if (phase === 'walk') {
      const p = Math.min(1, t / WALK_MS);
      const x = startX + (reachX - startX) * p;
      const hop = Math.abs(Math.sin(p * Math.PI * 5)) * g.size * 0.14;
      place(el, x, g.groundY - g.size - hop, 1, 1, Math.sin(p * Math.PI * 10) * 4);
      if (p >= 1) { phase = 'strike'; since = clock; }
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
      phase = 'walk'; since = clock;
      show(current);
    }
    requestAnimationFrame(frame);
  }

  // A click on the walking agent: Emm catches it now. With reduced motion: just its color.
  agents.forEach((el, i) => el.addEventListener('click', () => {
    if (reduce.matches) return takeColor(i);
    if (i === current && phase === 'walk') { phase = 'strike'; since = clock; }
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
