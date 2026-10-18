// The hero orbit: the names Claude Code, Codex and Cursor circle Codemm on a tilted ring,
// passing behind and in front of it. One dips in to charge Codemm every few
// seconds, a click sends that agent in, and the scene tilts with the pointer.
// Emm turns the color of the agent that charged Codemm. It has a pause button, stops offscreen and in hidden tabs, and with reduced
// motion it holds still.
const orbit = document.querySelector('.orbit');

if (orbit) {
  const scene = orbit.querySelector('.orbit-scene');
  const ring = orbit.querySelector('.orbit-ring');
  const core = orbit.querySelector('.core');
  const emm = orbit.querySelector('.emm');
  const agents = [...orbit.querySelectorAll('.agent')];
  const toggle = orbit.querySelector('.motion');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  const SPEED = (Math.PI * 2) / 14000; // one lap in 14 s
  const STILL = [Math.PI, 0, Math.PI / 2]; // left, right, front: where they rest without motion
  const DIP_EVERY = 2600;
  const DIP_MS = 1100;
  // Emm, a chameleon, takes the color of the agent that charges Codemm: body, dark, belly, stripes.
  const COLORS = [
    ['#E8875F', '#C1613A', '#F8D3C2', '#D97757'], // Claude Code
    ['#7383F7', '#4A57DB', '#D6DBFD', '#5F6EF0'], // Codex
    ['#636B7A', '#3B414D', '#CDD2DB', '#4F5664'], // Cursor
  ];

  let paused = false;
  let visible = true;
  let angle = -Math.PI / 2;
  let last = performance.now();
  let started = performance.now();
  let lastDip = performance.now();
  let nextDip = 0;
  const dips = agents.map(() => null); // start time of an agent's dip into Codemm
  let tiltX = 0, tiltY = 0, aimX = 0, aimY = 0;

  const moving = () => !reduce.matches && !paused && visible && !document.hidden;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  function chargeCore(i) {
    const [b, d, be, st] = COLORS[i];
    orbit.style.setProperty('--emm-b', b);
    orbit.style.setProperty('--emm-d', d);
    orbit.style.setProperty('--emm-be', be);
    orbit.style.setProperty('--emm-s', st);
    if (reduce.matches) return; // the colors change, but nothing moves
    core.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'ease-out' });
    core.animate([{ boxShadow: getComputedStyle(core).boxShadow }, { boxShadow: '0 0 0 10px rgb(61 219 108 / .35), 0 30px 60px -18px rgb(8 26 60 / .65)' }, { boxShadow: getComputedStyle(core).boxShadow }], { duration: 700, easing: 'ease-out' });
    emm.animate([{ transform: 'translateY(0) rotate(0)' }, { transform: 'translateY(-16px) rotate(-4deg)' }, { transform: 'translateY(0) rotate(0)' }], { duration: 560, easing: 'cubic-bezier(.3,1.6,.5,1)' });
  }

  function dip(i, now = performance.now()) {
    if (reduce.matches) return chargeCore(i);
    if (!dips[i]) dips[i] = now;
  }

  function layout(now) {
    const r = ring.getBoundingClientRect();
    const s = scene.getBoundingClientRect();
    const cx = r.left - s.left + r.width / 2;
    const cy = r.top - s.top + r.height / 2;
    const rx = r.width / 2;
    const ry = r.height / 2;
    const intro = reduce.matches ? 1 : ease(Math.min(1, (now - started) / 1200));
    agents.forEach((el, i) => {
      const theta = reduce.matches ? STILL[i] : angle + (i * Math.PI * 2) / 3;
      let k = intro; // 0 at the core, 1 on the ring
      if (dips[i]) {
        const t = (now - dips[i]) / DIP_MS;
        if (t >= 1) dips[i] = null;
        else {
          const d = Math.sin(Math.PI * Math.min(1, t)); // in and back out
          k *= 1 - 0.78 * d;
          if (t > 0.45 && !el.dataset.charged) { el.dataset.charged = '1'; chargeCore(i); }
        }
      }
      if (!dips[i]) delete el.dataset.charged;
      const depth = Math.sin(theta); // -1 behind, +1 in front
      const x = cx + Math.cos(theta) * rx * k;
      const y = cy + depth * ry * k;
      const scale = 0.72 + 0.34 * (depth + 1) / 2;
      el.style.transform = `translate3d(${x - el.offsetWidth / 2}px, ${y - el.offsetHeight / 2}px, 0) scale(${scale})`;
      el.style.zIndex = depth > 0 ? '3' : '1';
      el.style.opacity = String(0.2 + 0.8 * intro);
      el.style.filter = depth > 0 ? 'none' : `brightness(${0.86 + 0.14 * (depth + 1)})`;
    });
    tiltX += (aimX - tiltX) * 0.08;
    tiltY += (aimY - tiltY) * 0.08;
    scene.style.transform = `perspective(1100px) rotateX(${tiltY}deg) rotateY(${tiltX}deg)`;
  }

  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    if (moving()) {
      angle += dt * SPEED;
      if (now - lastDip > DIP_EVERY && now - started > 2000) {
        lastDip = now;
        dip(nextDip, now);
        nextDip = (nextDip + 1) % agents.length;
      }
    }
    layout(now);
    if (!reduce.matches) requestAnimationFrame(frame);
  }

  agents.forEach((el, i) => el.addEventListener('click', () => dip(i)));

  orbit.addEventListener('pointermove', (e) => {
    if (reduce.matches || paused) return;
    const b = orbit.getBoundingClientRect();
    aimX = ((e.clientX - b.left) / b.width - 0.5) * 14;
    aimY = -((e.clientY - b.top) / b.height - 0.5) * 10;
  });
  orbit.addEventListener('pointerleave', () => { aimX = 0; aimY = 0; });

  function setPaused(value) {
    paused = value;
    orbit.classList.toggle('paused', paused);
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    if (paused) { aimX = 0; aimY = 0; }
  }
  toggle.addEventListener('click', () => setPaused(!paused));

  const showToggle = () => { toggle.hidden = reduce.matches; };
  showToggle();
  reduce.addEventListener('change', () => { showToggle(); last = performance.now(); requestAnimationFrame(frame); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(orbit);
  addEventListener('resize', () => layout(performance.now()));

  requestAnimationFrame(frame);
}
