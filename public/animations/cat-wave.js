/**
 * cat-wave.js - the third Octocat, waving hello. Built on cat-rig.js.
 *
 * Requires cat-rig.js to be loaded first.
 *
 * WHERE A WAVE CAN ACTUALLY BE SEEN
 * ---------------------------------
 * The cat is a black silhouette, so a raised paw only reads where it overlaps
 * something that is not also black. Probing the outline for its rightmost x at
 * each height: the hood's own edge sits at x~297 down to y 132, the three
 * whiskers spike out across y 136-152 (as far as x 378), then the cheek sweeps
 * in hard - x 285 at y 156 to x 220 at y 184, the narrowest point on the whole
 * right side - before the body steps back out to x~234 from y 188 down and holds
 * it. So the clear pocket is out to the cat's right below the whiskers and
 * outside that notch. AT_WAVE sits in it.
 *
 * THE ARM IS TWO BONES, NOT ONE
 * -----------------------------
 * It used to be a single rigid segment rotated about the shoulder and stretched
 * along its own axis, which sweeps as a board. So the free limb is now upper arm
 * + forearm about an elbow (R.solveArm / R.setArm in cat-rig.js): standard 2D
 * cut-out practice, forearm parented to the upper arm, artwork overlapped at the
 * joint so no gap opens when it bends.
 *
 * The end of the limb needs nothing added to it. It is a tentacle tip, and it
 * tapers to its own point exactly as the three planted limbs do.
 *
 * WHY THE TARGET MOVED. A bent chain is shorter end to end, so holding the old
 * target at (288, 206) while adding a 28-degree elbow would have cost 1.355 of
 * stretch instead of 1.289 - past the point where the paw stops matching the
 * other three. Pulling the target in and up gets the bend for free: at
 * (272, 190) the stretch is 1.249, slightly *less* than the straight arm used,
 * and the hand sits nearer shoulder height where a wave actually reads. The
 * elbow lands at (255.6, 218.5), a clear 21 units outside the body's own edge
 * at that height, which is what makes the bend visible at all rather than
 * buried in the chest.
 *
 * Clearance is unchanged in kind: the body's right edge is x 226.8 at y 190 and
 * the whiskers stop at y 158, so the paw clears black by 36 units at rest and
 * by 16 at the top of the swing.
 *
 * THE BEAT. A human wave is mostly forearm - the shoulder barely moves, the
 * elbow does the work, and each joint lags the one above it. One driver read at
 * three delays (shoulder now, forearm FORE_LAG later, wrist later still) is what
 * makes the wave travel outward instead of the arm swinging rigidly; it is the
 * same principle as the tail's whip in cat-rig.js. Peaks are flattened so the
 * hand dwells at each extreme before snapping back.
 *
 * Note the free-limb trim in cat-rig.js (seam rule 4) - without it the shoulder
 * wedge above this limb's hinge swings clear of the shoulder and lands between
 * the feet as a fifth paw.
 *
 * Usage: new CatWave('#stage3', { bubble: true })
 * Aliases: CatHi
 */
(function (global) {
  'use strict';

  const R = global.CatRig;
  if (!R) throw new Error('cat-wave.js requires cat-rig.js to be loaded first');

  const { clamp, smooth, lerp, GEO, LIMBS } = R;
  const TAU = Math.PI * 2;

  const HAND = 3;                 // the rightmost limb - outer right, the waver
  const ELBOW_TUCK = 0.6;         // how far the arm shortens mid-swing on the way up
  const BLINK_DUR = 0.19;

  // The arm now has a real elbow (R.solveArm / R.setArm), which changes where
  // the paw wants to sit. A bent chain is shorter end to end, so the old target
  // out at (288, 206) would have cost 1.40 of stretch instead of 1.29 - past the
  // point where the paw stops matching the other three. Pulling the target in
  // and up buys the bend for nothing: at (272, 190) with a 28-degree elbow the
  // stretch is 1.26, slightly *less* than the straight arm used, and the hand
  // ends up nearer shoulder height where a wave actually reads.
  //
  // Clearance still holds. The body's right edge is x 226.8 at y 190 and the
  // whiskers stop at y 158, so a paw centred (272, 190) with its ~9 unit radius
  // clears black by 36 units; at the top of the swing it rides up to about
  // (265, 183) and still clears by 16.
  const AT_WAVE = { x: 272, y: 190 };
  const ELBOW_BEND = -28;               // degrees of elbow, held through the wave

  // A human wave is mostly forearm: the shoulder barely moves, the elbow does
  // the work, and each joint down the chain lags the one above it. That lag is
  // the whole reason a wave reads as one motion travelling outward instead of
  // the arm swinging as a board - the same principle as the tail's whip.
  const WAVE_HZ = 2.1;                  // beats per second (human ~2-3 Hz)
  const SHOULDER_AMP = 3.5;             // the shoulder only sways
  const FORE_AMP = 13;                  // the elbow carries the wave
  const FORE_LAG = 0.13;                // forearm trails the shoulder, in cycles
  const FLICK_AMP = 4.5;                // wrist flick on top of the forearm
  const FLICK_HZ = 2.7;                 // wrist is faster still
  const FLICK_LAG = 0.22;               // and lags further again

  const SCRIPT = [
    { s: 'idle', d: 1.9 },
    { s: 'raise', d: 0.42 },
    { s: 'wave', d: 2.15 },
    { s: 'lower', d: 0.40 },
    { s: 'idle', d: 1.4 }
  ];

  let SEQ = 0;

  const REST = { deg: 0, bend: 0, k: 1 };
  const UP = R.solveArm(LIMBS[HAND], AT_WAVE, ELBOW_BEND);

  // Speech bubble: rounded box with a tail pointing back down at the head, in
  // the empty space above the right whiskers. One path, so the tail's join needs
  // no overdraw to hide a seam.
  const BUBBLE_D =
    'M307 50 H359 A11 11 0 0 1 370 61 V79 A11 11 0 0 1 359 90 H336 L300 106 ' +
    'L316 90 H307 A11 11 0 0 1 296 79 V61 A11 11 0 0 1 307 50 Z';
  const BUBBLE_AT = { x: 300, y: 106 };   // the tail's tip - the pop's anchor

  /** Overshooting ease for the bubble: snaps past 1, settles back. */
  function pop(q) {
    if (q <= 0) return 0;
    if (q >= 1) return 1;
    return 1 - Math.pow(1 - q, 3) * Math.cos(q * Math.PI * 1.4);
  }

  class CatWave {
    constructor(container, opts) {
      opts = opts || {};
      R.ensureStyle();

      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('CatWave: container not found: ' + container);
      this.container.textContent = '';
      this.container.classList.add('cw-stage');

      const theme = opts.theme === 'plumber' ? 'plumber' : null;
      this.h = R.build('cv' + (++SEQ), { freeHandIndex: HAND, theme });
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', theme === 'plumber' ? 'Plumber Octocat waving hello' : 'GitHub Octocat waving hello');
      R.el('title', null, this.svg).textContent = theme === 'plumber' ? 'Plumber Octocat - waving' : 'GitHub Octocat - waving';

      // bubble rides the body so it moves with the cat, and sits above everything
      this.bubbleG = null;
      if (opts.bubble !== false) {
        const g = R.el('g', { id: 'cv' + SEQ + '-bubble', opacity: '0' }, this.h.bob);
        R.el('path', { d: BUBBLE_D, fill: '#fff', stroke: '#171515', 'stroke-width': '2.6', 'stroke-linejoin': 'round' }, g);
        const txt = R.el('text', {
          x: '333', y: '78', 'text-anchor': 'middle', fill: '#171515',
          'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif',
          'font-size': '27', 'font-weight': '700'
        }, g);
        txt.textContent = 'Hi!';
        this.bubbleG = g;
      }

      this.actor = document.createElement('div');
      this.actor.className = 'cw-actor';
      this.actor.appendChild(this.svg);
      this.container.appendChild(this.actor);

      this._label = document.createElement('div');
      this._label.className = 'cw-label';
      this._label.textContent = 'hello · paw up · wave · wink';
      this.container.appendChild(this._label);

      this.t = 0;
      this.idx = 0;
      this.state = SCRIPT[0].s;
      this.stateT = 0;
      this.blinkIn = 1.1 + Math.random() * 2;
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

    /** Back to the top of the loop, paw down. */
    restart() {
      this.idx = 0;
      this.state = SCRIPT[0].s;
      this.stateT = 0;
      this.t = 0;
      this.blinkT = -1;
      this.blinkIn = 1.1;
      this._render(0);
      return this.start();
    }

    /** Jump straight to the wave, for a click-to-greet. */
    greet() {
      this.idx = 1;
      this.state = SCRIPT[1].s;
      this.stateT = 0;
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
        // the paw comes back down into the water at the end of `lower`
        if (this.state === 'idle' && this.idx > 0) {
          R.spawnRipple(this.h.ripples, LIMBS[HAND].foot.x, GEO.rippleY);
        }
      }

      // blink only when the face is otherwise neutral; the wave has its own wink
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        if (this.blinkT > BLINK_DUR) { this.blinkT = -1; this.blinkIn = 1.7 + Math.random() * 2.2; }
      } else if (this.state === 'idle' && (this.blinkIn -= dt) <= 0) {
        this.blinkT = 0;
      }
    }

    // ----------------------------------------------------------------- render

    _render(dt) {
      const h = this.h, t = this.t, s = this.state;
      const p = clamp(this.stateT / SCRIPT[this.idx].d, 0, 1);

      // --- the waving arm ---
      let deg = REST.deg, bend = REST.bend, k = REST.k, focus = 0, beat = 0, wink = 0, show = 0;

      if (s === 'raise' || s === 'lower') {
        // `lower` is the same arc played backwards
        const q = smooth(s === 'raise' ? p : 1 - p);
        deg = lerp(REST.deg, UP.deg, q);
        // The elbow leads the raise: it folds early and opens out as the arm
        // arrives, which is what an arm does and what keeps the paw inside the
        // silhouette on the way past the feet.
        bend = lerp(REST.bend, UP.bend, q) + ELBOW_TUCK * 26 * Math.sin(Math.PI * q) * Math.sign(UP.bend || -1);
        k = lerp(REST.k, UP.k, q) - ELBOW_TUCK * 0.35 * Math.sin(Math.PI * q);
        focus = q;
        show = s === 'raise' ? Math.max(0, q * 2 - 1) : q;
      } else if (s === 'wave') {
        // Human-style wave: the shoulder provides the base swing, the wrist
        // flicks faster and smaller on top, and the elbow flexes subtly so the
        // arm foreshortens slightly at each reversal - like a person waving
        // with their lower arm rather than windmilling from the shoulder.
        // The envelope still eases the first/last beat, and we add a slight
        // dwell at each extreme (human hands pause before snapping back).
        const env = clamp(Math.sin(Math.PI * p) * 2.2, 0, 1);
        // One driver, read at three delays - shoulder now, forearm a beat later,
        // wrist later still. Peaks are flattened (pow < 1) so the hand dwells at
        // each extreme before snapping back, as a real hand does.
        const drive = ph => {
          const v = Math.sin(TAU * WAVE_HZ * (this.stateT - ph));
          return Math.sign(v) * Math.pow(Math.abs(v), 0.78);
        };
        const shaped = drive(0);
        beat = shaped;
        const foreBeat = drive(FORE_LAG / WAVE_HZ);
        const flick = Math.sin(TAU * FLICK_HZ * (this.stateT - FLICK_LAG / WAVE_HZ) + 0.7)
                    * (0.9 + 0.25 * Math.sin(TAU * 0.9 * this.stateT));
        deg = UP.deg + shaped * SHOULDER_AMP * env;
        bend = UP.bend + (foreBeat * FORE_AMP + flick * FLICK_AMP * (0.7 + 0.3 * (1 - Math.abs(foreBeat)))) * env;
        // a touch of reach on the outswing, so the arm breathes rather than
        // holding one rigid length through the beat
        k = UP.k + Math.abs(foreBeat) * 0.03 * env;
        focus = 1;
        show = 1;
        // one slow wink, a third of the way in
        wink = clamp(1 - Math.abs(p - 0.34) * 9, 0, 1);
      }

      R.setArm(h, { deg: deg, bend: bend, k: k });

      // --- bubble: pops in on the raise, holds through the wave, drops out ---
      if (this.bubbleG) {
        const a = s === 'wave' ? 1 : show;
        if (a < 0.01) this.bubbleG.setAttribute('opacity', '0');
        else {
          const sc = 0.55 + 0.45 * pop(a) + (s === 'wave' ? beat * 0.012 : 0);
          this.bubbleG.setAttribute('opacity', Math.min(1, a * 1.6).toFixed(2));
          this.bubbleG.setAttribute('transform',
            `translate(${BUBBLE_AT.x} ${BUBBLE_AT.y}) scale(${sc.toFixed(3)}) ` +
            `translate(${-BUBBLE_AT.x} ${-BUBBLE_AT.y})`);
        }
      }

      // --- body: weight shifts off the raised side, and bounces on the beat ---
      const breathe = Math.sin(t * 1.4) * 0.5;
      const swayX = -focus * 2.0;                    // lean away from the raised arm
      const bobY = breathe - focus * 0.6 + (s === 'wave' ? Math.abs(beat) * -0.7 : 0);
      const roll = -focus * 1.2;
      h.bob.setAttribute('transform',
        `translate(${swayX.toFixed(2)} ${bobY.toFixed(2)}) ` +
        `rotate(${roll.toFixed(2)} ${GEO.ground.x} ${GEO.ground.y})`);

      // --- the three planted limbs: hold their paws still, brace on the lean ---
      // Counter-rotation about the hip, never a sideways slide - see the seam
      // rules in cat-rig.js.
      for (let i = 0; i < 4; i++) {
        if (i === HAND) continue;
        const idle = Math.sin(t * 0.95 + i * 2.1) * 0.6;
        const brace = focus * (i === 0 ? 1.5 : i === 1 ? -0.8 : -1.3);
        R.setLimb(h.limbGs[i], LIMBS[i], -bobY,
          idle + brace + R.swayDeg(LIMBS[i], -swayX));
      }

      // --- tail: up and swishing fast, whipping on the same beat as the paw ---
      const tailA = Math.sin(t * 0.8) * 2.4 + focus * 4.2 + (s === 'wave' ? beat * 2.6 : 0);
      const whip = Math.sin(t * 0.8 + 1.4) * 2.0 + (s === 'wave' ? beat * 4.5 : 0);
      R.setTail(h, tailA, -tailA * 0.4 + Math.sin(t * 1.8) * 1.1, whip);

      // --- ears: pricked right up while greeting, flicking on the beat ---
      for (let i = 0; i < 2; i++) {
        const off = i * 1.9;
        const twitch = Math.sin(t * 1.9 + off) * 0.5
          + (Math.sin(t * 5.9 + off) > 0.975 ? 2.1 : 0);
        R.setEar(h, i, twitch - focus * 0.9 + (s === 'wave' ? beat * 0.8 * (i ? 1 : -1) : 0),
          1.0 + focus * 2.6);
      }

      // --- whiskers forward and up while greeting ---
      const twitch = Math.sin(t * 1.8) * 0.9 + (Math.sin(t * 5.1) > 0.985 ? 1.4 : 0);
      const fwd = focus * 4.4 + (s === 'wave' ? beat * 1.3 : 0);
      h.whiskL.setAttribute('transform',
        `rotate(${(-fwd + twitch).toFixed(2)} ${GEO.whiskL.pivot.x} ${GEO.whiskL.pivot.y})`);
      h.whiskR.setAttribute('transform',
        `rotate(${(fwd - twitch).toFixed(2)} ${GEO.whiskR.pivot.x} ${GEO.whiskR.pivot.y})`);

      // --- face: a wider mouth while greeting, and the wink ---
      // safe to scale: the mouth sits wholly inside the peach face, no seam
      const mw = 1 + focus * 0.16, mh = 1 + focus * 0.3;
      h.mouthG.setAttribute('transform',
        `translate(${GEO.mouth.x} ${GEO.mouth.y}) scale(${mw.toFixed(3)} ${mh.toFixed(3)}) ` +
        `translate(${-GEO.mouth.x} ${-GEO.mouth.y})`);

      const blink = this.blinkT >= 0 ? Math.sin(Math.PI * (this.blinkT / BLINK_DUR)) : 0;
      const squint = focus * 0.28;
      R.setLids(h, Math.max(blink, squint), Math.max(blink, squint, wink));

      R.stepRipples(h.ripples, dt * 1000, 620, 28, 6);
    }
  }

  global.CatWave = CatWave;
  global.CatHi = CatWave;
  if (typeof module !== 'undefined' && module.exports) module.exports = CatWave;
})(typeof window !== 'undefined' ? window : this);
