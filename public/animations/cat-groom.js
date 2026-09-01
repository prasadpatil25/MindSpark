/**
 * cat-groom.js - the second Octocat, washing its face. Built on cat-rig.js.
 *
 * Requires cat-rig.js to be loaded first.
 *
 * THE REACH PROBLEM
 * -----------------
 * A cat washes its face by licking a forepaw and wiping it over the muzzle. The
 * rig gives each limb one rigid segment, and this one is about 52 units long
 * from its shoulder at (153, 231) - while the muzzle is 64 units away. A pure
 * rotation can never get there: the paw is stuck on a circle that stops short.
 * So the reaching arm also stretches along its own axis; R.solveReach() works
 * out the exact rotation and stretch that lands the paw on a given point, and
 * explains why the stretch is cheap on this particular cat.
 *
 * Mid-raise the elbow "tucks" - k dips below 1 - which keeps the swinging paw
 * inside the silhouette instead of flashing across the gap between the right
 * feet. The sweep is invisible; the paw simply appears at the muzzle.
 *
 * The other three limbs stay planted, cancelling the body's own shift so they do
 * not slide - as a counter-rotation about the hip rather than a sideways slide,
 * exactly as in the walk, and for the same reason: the hip must stay a fixed
 * point or the limb steps out of its own socket.
 *
 * Usage: new CatGroom('#stage2')
 * Aliases: CatLick
 */
(function (global) {
  'use strict';

  const R = global.CatRig;
  if (!R) throw new Error('cat-groom.js requires cat-rig.js to be loaded first');

  const { clamp, smooth, lerp, GEO, LIMBS } = R;

  const HAND = 0;                 // the free forepaw - outer left, nearest the viewer
  const ELBOW_TUCK = 0.55;        // how far the arm shortens at mid-sweep
  const BLINK_DUR = 0.19;

  // Where the paw goes. Just left of and below the mouth, so the tongue has a
  // clear line to it and the paw covers part of the left muzzle.
  const AT_MUZZLE = { x: 176, y: 173 };
  const AT_CHEEK = { x: 169, y: 160 };   // the up-and-over wipe

  // One loop of grooming. Real cats work in short bursts: a few quick licks,
  // a couple of wipes, then a pause to look around.
  const SCRIPT = [
    { s: 'settle', d: 1.7 },
    { s: 'raise', d: 0.55 },
    { s: 'lick', d: 0.40 }, { s: 'lick', d: 0.40 }, { s: 'lick', d: 0.40 },
    { s: 'rub', d: 0.52 }, { s: 'rub', d: 0.52 },
    { s: 'lick', d: 0.40 }, { s: 'lick', d: 0.40 },
    { s: 'rub', d: 0.52 },
    { s: 'lower', d: 0.50 },
    { s: 'tap', d: 0.42 },
    { s: 'settle', d: 1.9 }
  ];

  let SEQ = 0;

  /** Rotation + axial stretch that puts the free paw on `t`. See R.solveReach. */
  const solve = t => R.solveReach(LIMBS[HAND], t);

  const REST = { deg: 0, k: 1 };
  const MUZZLE = solve(AT_MUZZLE);
  const CHEEK = solve(AT_CHEEK);

  const applyReach = (g, deg, k) => R.setReach(g, LIMBS[HAND], deg, k);

  /** Teardrop tongue from the mouth, leaning toward whatever it is licking. */
  function setTongue(el, amount, toward) {
    if (amount < 0.02) { el.setAttribute('opacity', '0'); return; }
    const mx = GEO.mouth.x, my = 163;
    const len = 4 + amount * 9;
    const tipX = mx + (toward.x - mx) * amount * 0.42;
    const tipY = my + len;
    const w = 2.6 + amount * 1.5;
    el.setAttribute('opacity', Math.min(1, amount * 1.7).toFixed(2));
    el.setAttribute('d',
      `M${(mx - w).toFixed(1)} ${my}` +
      ` Q${(tipX - w * 0.8).toFixed(1)} ${(tipY - 1.5).toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}` +
      ` Q${(tipX + w * 0.8).toFixed(1)} ${(tipY - 1.5).toFixed(1)} ${(mx + w).toFixed(1)} ${my} Z`);
  }

  class CatGroom {
    constructor(container, opts) {
      opts = opts || {};
      R.ensureStyle();

      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('CatGroom: container not found: ' + container);
      this.container.textContent = '';
      this.container.classList.add('cw-stage');

      const theme = opts.theme === 'plumber' ? 'plumber' : null;
      this.h = R.build('cg' + (++SEQ), { freeHandIndex: HAND, theme });
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', theme === 'plumber' ? 'Plumber Octocat washing its face' : 'GitHub Octocat washing its face');
      R.el('title', null, this.svg).textContent = theme === 'plumber' ? 'Plumber Octocat - grooming' : 'GitHub Octocat - grooming';
      // the tongue has to land on top of the raised paw, and the paw is already
      // the last thing in the body group
      this.h.bob.appendChild(this.h.tongue);

      this.actor = document.createElement('div');
      this.actor.className = 'cw-actor';
      this.actor.appendChild(this.svg);
      this.container.appendChild(this.actor);

      this._label = document.createElement('div');
      this._label.className = 'cw-label';
      this._label.textContent = 'face wash · lick paw → wipe muzzle → set down';
      this.container.appendChild(this._label);

      this.t = 0;
      this.idx = 0;
      this.state = SCRIPT[0].s;
      this.stateT = 0;
      this.blinkIn = 1.2 + Math.random() * 2;
      this.blinkT = -1;
      this.running = false;
      this._raf = 0;
      this._prev = 0;

      this._centre();
      this._onResize = () => this._centre();
      window.addEventListener('resize', this._onResize);
      this._onVis = () => {
        if (document.hidden) { this._wasRunning = this.running; this.pause(); }
        else if (this._wasRunning) this.start();
      };
      document.addEventListener('visibilitychange', this._onVis);

      this._render(0);
      if (opts.autoStart !== false) this.start();
    }

    // --------------------------------------------------------------- controls

    start() {
      if (this.running) return this;
      this.running = true;
      this._prev = 0;
      const loop = ts => {
        if (!this.running) return;
        const dt = this._prev ? Math.min((ts - this._prev) / 1000, 0.05) : 0;
        this._prev = ts;
        this._step(dt);
        this._render(dt);
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
      return this;
    }

    pause() {
      this.running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      return this;
    }

    /** Back to the top of the grooming loop, paw down. */
    restart() {
      this.idx = 0;
      this.state = SCRIPT[0].s;
      this.stateT = 0;
      this.t = 0;
      this.blinkT = -1;
      this.blinkIn = 1.2;
      this._render(0);
      return this.start();
    }

    destroy() {
      this.pause();
      window.removeEventListener('resize', this._onResize);
      document.removeEventListener('visibilitychange', this._onVis);
      if (this.actor.parentNode) this.actor.parentNode.removeChild(this.actor);
      if (this._label.parentNode) this._label.parentNode.removeChild(this._label);
      this.container.classList.remove('cw-stage');
      return this;
    }

    // ------------------------------------------------------------------ state

    _centre() {
      const w = this.container.clientWidth || 720;
      const aw = this.actor.offsetWidth || 300;
      this.actor.style.left = Math.max(0, (w - aw) / 2).toFixed(1) + 'px';
    }

    _step(dt) {
      this.t += dt;
      this.stateT += dt;

      if (this.stateT >= SCRIPT[this.idx].d) {
        this.stateT = 0;
        this.idx = (this.idx + 1) % SCRIPT.length;
        this.state = SCRIPT[this.idx].s;
        // the paw comes down wet: a tap rings the puddle, and each lick shakes
        // a drop off the raised paw
        if (this.state === 'tap') R.spawnRipple(this.h.ripples, LIMBS[HAND].foot.x, GEO.rippleY);
        else if (this.state === 'lick') R.spawnRipple(this.h.ripples, AT_MUZZLE.x, GEO.rippleY);
      }

      // Blink only while the eyes are otherwise open - during a lick they are
      // already half shut, and a blink on top of that just reads as a flicker.
      const canBlink = this.state === 'settle' || this.state === 'tap';
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        if (this.blinkT > BLINK_DUR) { this.blinkT = -1; this.blinkIn = 1.8 + Math.random() * 2.4; }
      } else if (canBlink && (this.blinkIn -= dt) <= 0) {
        this.blinkT = 0;
      }
    }

    // ----------------------------------------------------------------- render

    _render(dt) {
      const h = this.h, t = this.t, s = this.state;
      const p = clamp(this.stateT / SCRIPT[this.idx].d, 0, 1);

      // --- the reaching arm ---
      let deg = REST.deg, k = REST.k, tongue = 0, lids = 0, focus = 0;

      if (s === 'raise' || s === 'lower') {
        // `lower` is the same arc played backwards
        const q = smooth(s === 'raise' ? p : 1 - p);
        deg = lerp(REST.deg, MUZZLE.deg, q);
        // elbow tucks at mid-sweep so the paw stays inside the silhouette
        k = lerp(REST.k, MUZZLE.k, q) - ELBOW_TUCK * Math.sin(Math.PI * q);
        focus = q;
        lids = q * 0.45;
      } else if (s === 'lick') {
        // the paw presses in toward the mouth as the tongue comes out
        const beat = Math.sin(Math.PI * p);
        deg = MUZZLE.deg - beat * 1.6;
        k = MUZZLE.k + beat * 0.045;
        tongue = beat;
        lids = 0.62;
        focus = 1;
      } else if (s === 'rub') {
        // up over the cheek and back down - the wipe
        const q = Math.sin(Math.PI * p);
        deg = lerp(MUZZLE.deg, CHEEK.deg, q);
        k = lerp(MUZZLE.k, CHEEK.k, q);
        lids = 0.78;
        focus = 1;
      } else if (s === 'tap') {
        // paw settles back into the water
        k = 1 + Math.sin(Math.PI * p) * 0.03;
      }

      applyReach(h.limbGs[HAND], deg, k);
      setTongue(h.tongue, tongue, AT_MUZZLE);

      // --- body: weight shifts off the raised paw onto the other side ---
      const breathe = Math.sin(t * 1.35) * 0.55;
      const swayX = focus * 1.5;                       // lean away from the lifted paw
      const bobY = breathe + (s === 'tap' ? Math.sin(Math.PI * p) * 0.9 : 0);
      const roll = focus * 0.9;
      h.bob.setAttribute('transform',
        `translate(${swayX.toFixed(2)} ${bobY.toFixed(2)}) ` +
        `rotate(${roll.toFixed(2)} ${GEO.ground.x} ${GEO.ground.y})`);

      // --- the three planted limbs: hold their paws still, brace a little ---
      // The counter-sway is a rotation about the hip rather than a sideways
      // slide: the hole each limb fills is fixed in the body's frame, so
      // translating one steps it out of its own socket - a visible jog at the
      // hip, held for as long as the cat leans.
      for (let i = 0; i < 4; i++) {
        if (i === HAND) continue;
        // a resting cat is never quite still; each paw adjusts on its own phase
        const idle = Math.sin(t * 0.9 + i * 2.1) * 0.7;
        const brace = focus * (i === 1 ? -1.4 : i === 2 ? 0.7 : 1.2);
        R.setLimb(h.limbGs[i], LIMBS[i], -bobY,
          idle + brace + R.swayDeg(LIMBS[i], -swayX));
      }

      // --- tail: slow contented sway, a flick when the paw hits the water ---
      const flick = s === 'tap' ? Math.sin(Math.PI * p) * 3.2 : 0;
      const tailA = Math.sin(t * 0.72) * 2.8 + Math.sin(t * 1.9) * 0.5 + flick;
      // the whip leads the swing by a quarter cycle, so the flick travels out
      const whip = Math.sin(t * 0.72 + 1.4) * 2.6 + flick * 1.5;
      R.setTail(h, tailA, -tailA * 0.4 + Math.sin(t * 1.7) * 1.1, whip);

      // --- ears: up and swivelling between bursts, tipped back while working ---
      for (let i = 0; i < 2; i++) {
        const off = i * 1.7;                  // the two never twitch in unison
        const twitch = Math.sin(t * 2.1 + off) * 0.45
          + (Math.sin(t * 6.1 + off) > 0.975 ? 2.0 : 0);   // occasional sharp flick
        const near = i === 0 ? 1.7 : 0.5;     // the ear over the working paw yields most
        R.setEar(h, i, focus * near + twitch, (1 - focus) * 1.6 - focus * 1.1);
      }

      // --- whiskers: fanned forward while grooming, micro-twitch at rest ---
      const twitch = Math.sin(t * 1.7) * 0.9 + (Math.sin(t * 5.3) > 0.985 ? 1.4 : 0);
      const fwd = focus * 3.6 + (s === 'lick' ? Math.sin(t * 14) * 0.8 : 0);
      h.whiskL.setAttribute('transform',
        `rotate(${(-fwd + twitch).toFixed(2)} ${GEO.whiskL.pivot.x} ${GEO.whiskL.pivot.y})`);
      h.whiskR.setAttribute('transform',
        `rotate(${(fwd - twitch).toFixed(2)} ${GEO.whiskR.pivot.x} ${GEO.whiskR.pivot.y})`);

      // --- eyes: grooming squint, plus real blinks when not squinting ---
      const blink = this.blinkT >= 0 ? Math.sin(Math.PI * (this.blinkT / BLINK_DUR)) : 0;
      R.setLids(h, Math.max(lids, blink));

      R.stepRipples(h.ripples, dt * 1000, 620, 26, 6);
    }
  }

  global.CatGroom = CatGroom;
  global.CatLick = CatGroom;
  if (typeof module !== 'undefined' && module.exports) module.exports = CatGroom;
})(typeof window !== 'undefined' ? window : this);
