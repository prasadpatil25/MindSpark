/**
 * cat-walk.js - the Octocat walking, built on the cat-rig.js limb rig.
 *
 * Requires cat-rig.js to be loaded first. See that file for why the limbs and
 * tail must be extracted from the single-subpath silhouette before anything can
 * move, and for the seam rules that bound the amplitudes used here.
 *
 * THE GAIT
 * --------
 * Cats walk in a *lateral-sequence* pattern - left hind, left fore, right hind,
 * right fore - each footfall a quarter-cycle after the last, with every paw on
 * the ground about two-thirds of the cycle. That overlap is what makes a walk a
 * walk: two or three paws are always planted, so there is no airborne moment
 * (a trot or a bound would have one). In this front-facing pose the outer limb
 * pair reads as the cat's hands (fore) and the taller inner pair as its feet
 * (hind), so the sequence maps to limbs [1, 0, 2, 3] - phases [0, ¼, ½, ¾].
 *
 * Facing the viewer, travel along the walking direction is mostly hidden, so
 * the readable cues are the ones driven here: the *order* the paws peel off the
 * water, the body dropping onto each paw as it takes weight, the roll and sway
 * onto the loaded side, and the tail counter-swinging against that sway.
 *
 * A planted paw must not slide, so stance limbs cancel the body's own shift -
 * but as a counter-*rotation* about the hip (R.swayDeg), never a sideways
 * translate. Likewise a swing paw rises by shortening its limb along its own
 * axis rather than by moving it up. Both are the same rule: the hip has to stay
 * a fixed point, or the limb steps out of the socket it fills. See the seam
 * rules in cat-rig.js. The amplitude budget below keeps the residual under the
 * protected band (bob ≤ ~2.2, limb rotation ≤ ~10°).
 *
 * Usage: new CatWalk('#stage', { speed: 80, stroll: true })
 * Aliases: OctocatWalk / GitHubCatWalk
 */
(function (global) {
  'use strict';

  const R = global.CatRig;
  if (!R) throw new Error('cat-walk.js requires cat-rig.js to be loaded first');

  const { clamp, smooth, GEO, LIMBS } = R;
  const TAU = Math.PI * 2;

  // Limb order is [hand-l, foot-l, foot-r, hand-r].
  const PHASE = [0.25, 0, 0.5, 0.75];  // lateral sequence: LH, LF, RH, RF
  const DUTY = 0.66;                   // fraction of the cycle a paw is planted
  const SIDE = [-1, -1, 1, 1];         // sign that swings a paw toward the centre
  const TUCK = [7.5, 5.2, 5.2, 7.5];   // swing arc, degrees - hands gesture more
  const LIFT = [7.0, 7.8, 7.8, 7.0];   // how far a paw clears the water
  const SPLAY = 2.0;                   // outward brace as a paw takes weight
  const BLINK_DUR = 0.19;

  // The loaded side leads the sway by an eighth of a cycle: that is the midpoint
  // of the left pair's shared stance, when the body is most over its left feet.
  const LOAD_LEAD = 0.125;

  let SEQ = 0;

  class CatWalk {
    constructor(container, opts) {
      opts = opts || {};
      R.ensureStyle();

      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('CatWalk: container not found: ' + container);
      this.container.classList.add('cw-stage');

      this.speed = opts.speed != null ? opts.speed : 80;
      this.dir = opts.direction < 0 ? -1 : 1;
      this.stroll = opts.stroll !== false;
      this.mode = opts.mode || 'walk';
      // When false, the walker animates the gait but never touches
      // actor.style.left - a host behaviour layer owns the position instead.
      // Two writers on one property means the loser's writes are silently
      // stomped every frame; the minimap cat drives its own path this way.
      this.ownPosition = opts.ownPosition !== false;

      this.theme = opts.theme === 'plumber' ? 'plumber' : null;
      this.h = R.build('cw' + (++SEQ), { theme: this.theme });
      this.svg = this.h.svg;
      const who = this.theme === 'plumber' ? 'Plumber Octocat' : 'GitHub Octocat';
      this.svg.setAttribute('aria-label', who + ' walking through a puddle');
      R.el('title', null, this.svg).textContent = who + ' - walking';

      this.actor = document.createElement('div');
      this.actor.className = 'cw-actor';
      this.actor.appendChild(this.svg);
      this.container.appendChild(this.actor);

      this._label = document.createElement('div');
      this._label.className = 'cw-label';
      this._label.textContent = 'lateral-sequence walk · LH → LF → RH → RF';
      this.container.appendChild(this._label);

      this.t = 0;          // animation clock, seconds
      this.phase = 0;      // gait cycle position, 0..1
      this.gait = 0;       // 0 = standing, ~1 = walking at reference speed
      this.rawX = 0;       // stroll offset, px
      this.maxX = 0;
      this.lastU = PHASE.map(() => 0);
      this.blinkIn = 1.6 + Math.random() * 3;
      this.blinkT = -1;
      this.running = false;
      this._raf = 0;
      this._prev = 0;

      this._layout();
      this._onResize = () => this._layout();
      window.addEventListener('resize', this._onResize);
      // a backgrounded tab stops delivering frames; remember whether we were
      // running so returning to it does not silently leave the cat frozen
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
        // no previous timestamp on the first frame; clamp the rest so a tab
        // that was hidden does not resume with one enormous step
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

    setSpeed(v) { this.speed = clamp(Number(v) || 0, 0, 240); return this; }
    setDirection(d) { this.dir = d < 0 ? -1 : 1; return this; }

    setStroll(on) {
      this.stroll = !!on;
      if (!this.stroll) this._centre();
      return this;
    }
    toggleStroll() { return this.setStroll(!this.stroll); }

    /** 'walk' = drift across · 'march' = walk in place · 'idle' = stand and breathe */
    setMode(m) {
      this.mode = m || 'walk';
      if (this.mode === 'idle') {
        this._held = this.speed || 80;
        this.setSpeed(0);
      } else {
        if (this.speed === 0) this.setSpeed(this._held || 80);
        this.setStroll(this.mode !== 'march');
      }
      return this;
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

    _layout() {
      const w = this.container.clientWidth || 720;
      const aw = this.actor.offsetWidth || 300;
      this.maxX = Math.max(0, w - aw - 12);
      if (!this.ownPosition) return;
      if (this.stroll) this.rawX = clamp(this.rawX, 6, Math.max(6, this.maxX));
      else this.rawX = Math.max(0, (w - aw) / 2);
      this.actor.style.left = this.rawX.toFixed(1) + 'px';
    }

    _centre() {
      if (!this.ownPosition) return;
      const w = this.container.clientWidth || 720;
      this.rawX = Math.max(0, (w - (this.actor.offsetWidth || 300)) / 2);
      this.actor.style.left = this.rawX.toFixed(1) + 'px';
    }

    _step(dt) {
      this.t += dt;
      const sp = Math.max(0, this.speed);
      const moving = sp > 0.5;

      // Cadence rises with speed: an unhurried cat takes about 1.15s for a full
      // cycle of four footfalls, and pushing the pace compresses that toward
      // half a second. Stride amplitude scales with it too, so a slow walk is a
      // shuffle rather than the same big step played back slowly.
      if (moving) {
        const cycle = clamp(1.15 - sp * 0.0035, 0.5, 1.3);
        this.phase = (this.phase + dt / cycle) % 1;
      }
      this.gait = moving ? clamp(sp / 70, 0.3, 1.15) : 0;

      // Stroll drifts the stage position and bounces off the edges. The cat
      // faces the viewer, so reversing direction never mirrors it.
      if (moving && this.stroll && this.ownPosition && this.maxX > 6) {
        this.rawX += this.dir * sp * dt;
        if (this.rawX >= this.maxX) { this.rawX = this.maxX; this.dir = -1; }
        else if (this.rawX <= 6) { this.rawX = 6; this.dir = 1; }
        this.actor.style.left = this.rawX.toFixed(1) + 'px';
      }

      if (this.blinkT >= 0) {
        this.blinkT += dt;
        if (this.blinkT > BLINK_DUR) { this.blinkT = -1; this.blinkIn = 2.4 + Math.random() * 3; }
      } else if ((this.blinkIn -= dt) <= 0) {
        this.blinkT = 0;
      }
    }

    // ----------------------------------------------------------------- render

    _render(dt) {
      const h = this.h, g = this.gait, ph = this.phase, t = this.t;

      // Body. Weight lands on a paw every quarter cycle, so the body dips at 4×
      // the cycle rate; the heavier 2× term is support swapping between the
      // diagonal couplets. Breathing keeps it alive while standing still.
      const breathe = Math.sin(t * 1.5) * 0.5;
      const bobY = g * (0.7 * Math.cos(TAU * 4 * ph) + 1.0 * Math.cos(TAU * 2 * ph)) + breathe;
      const load = Math.cos(TAU * (ph - LOAD_LEAD));   // +1 = weight on the left pair
      const swayX = -g * 1.4 * load;
      const roll = -g * 1.3 * load;                    // leans onto the loaded side

      h.bob.setAttribute('transform',
        `translate(${swayX.toFixed(2)} ${bobY.toFixed(2)}) ` +
        `rotate(${roll.toFixed(2)} ${GEO.ground.x} ${GEO.ground.y})`);

      // Limbs - hands and feet alike.
      for (let i = 0; i < 4; i++) {
        const u = (ph - PHASE[i] + 1) % 1;
        let lift, ang;

        if (u < DUTY) {
          // Stance. The paw is planted in the puddle, so hold it still against
          // the body's sway - as a counter-rotation about the hip, never a
          // sideways slide, which would step the leg out of its own socket.
          const s = u / DUTY;
          lift = -bobY;
          ang = -SIDE[i] * SPLAY * Math.sin(Math.PI * s) * g
              + R.swayDeg(LIMBS[i], -swayX);
        } else {
          // Swing. The paw peels off, arcs up and in past the standing limb,
          // then sets back down. No cancellation - it travels with the body.
          const w = (u - DUTY) / (1 - DUTY);
          lift = -LIFT[i] * g * Math.sin(Math.PI * w);
          ang = SIDE[i] * TUCK[i] * g * Math.sin(Math.PI * smooth(w));
        }

        R.setLimb(h.limbGs[i], LIMBS[i], lift, ang);

        // Foot-plant: u wraps past 1 back to 0 exactly as the paw touches down.
        if (g && u < this.lastU[i]) R.spawnRipple(h.ripples, LIMBS[i].foot.x, GEO.rippleY);
        this.lastU[i] = u;
      }

      // The tail counter-swings against the sway - that is most of what a
      // walking cat's tail is doing. The droplet is hanging fluid, so it trails.
      // The whip leads the swing by a quarter cycle, so each swish travels from
      // root to tip instead of the whole sickle pivoting as a board.
      const tailA = Math.sin(t * 1.05) * 2.2 + g * 3.4 * load;
      const whip = Math.sin(t * 1.05 + 1.5) * 1.6 - g * 3.0 * Math.sin(TAU * (ph - LOAD_LEAD));
      R.setTail(h, tailA, -tailA * 0.35 + Math.sin(t * 1.9) * 1.2, whip);

      // Ears: pricked while walking, jolted by each footfall, and swivelling
      // independently now and then - on a face this simple that reads as alive
      // more than anything else here does.
      const jolt = g * Math.sin(TAU * 4 * ph) * 0.9;
      for (let i = 0; i < 2; i++) {
        const off = i * 2.3;
        const swivel = Math.sin(t * 1.6 + off) * 0.7
          + (Math.sin(t * 5.7 + off) > 0.97 ? 2.4 : 0);
        R.setEar(h, i, swivel + jolt * (i ? 1 : -1),
          1.1 * g + Math.sin(t * 2.2 + off) * 0.35);
      }

      // Whiskers flare symmetrically, with a jolt on each footfall.
      const wk = Math.sin(t * 2.3) * 1.0 + g * Math.sin(TAU * 2 * ph) * 1.1;
      h.whiskL.setAttribute('transform',
        `rotate(${(-wk).toFixed(2)} ${GEO.whiskL.pivot.x} ${GEO.whiskL.pivot.y})`);
      h.whiskR.setAttribute('transform',
        `rotate(${wk.toFixed(2)} ${GEO.whiskR.pivot.x} ${GEO.whiskR.pivot.y})`);

      R.setLids(h, this.blinkT >= 0 ? Math.sin(Math.PI * (this.blinkT / BLINK_DUR)) : 0);
      R.stepRipples(h.ripples, dt * 1000, 620, 30, 7);
    }
  }

  global.CatWalk = CatWalk;
  global.OctocatWalk = CatWalk;
  global.GitHubCatWalk = CatWalk;
  if (typeof module !== 'undefined' && module.exports) module.exports = CatWalk;
})(typeof window !== 'undefined' ? window : this);
