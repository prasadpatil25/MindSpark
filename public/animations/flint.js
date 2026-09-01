/**
 * flint.js - Flint, a mascot candidate for MindSpark.
 *
 * WHY THIS SHAPE
 * --------------
 * Sprig is a soft pebble and Nib is a wedge that writes. Flint takes the third
 * position, and it is a position about the SILHOUETTE rather than the idea: it
 * is the only one of the three that is not round. Every edge is straight, every
 * corner is mitered, and there is not one circle in the body. Next to a canvas
 * full of rounded node cards that is the point - the character reads as a chip
 * of something hard sitting on a soft page, and it survives being shrunk
 * because a faceted outline stays legible when an outline of curves turns to
 * mush.
 *
 * What it emotes with is the EMBER: a mote of light that lives off the body
 * entirely. Sprig emotes with its fork and Nib with the line it leaves, so
 * Flint needed a third answer, and a detached one is the most expressive of the
 * three because it can travel. It orbits when curious, trails when moving,
 * flares and throws sparks on an idea, sweeps a full arc to wave, and burns
 * down to a dull coal asleep. The body barely moves; the light does the acting.
 *
 * The name is the mechanism: flint is the thing that is struck to make a spark,
 * and MindSpark's mark is a four-point spark on a terracotta square. The mascot
 * and the logo are then two halves of the same sentence, which is the one thing
 * neither Sprig nor Nib can claim.
 *
 * WHY IT IS BUILT LIKE THIS
 * -------------------------
 * Same construction rules as sprig.js: every part its own element, no masks, and
 * LAG down every chain so motion travels instead of arriving all at once.
 *
 * One rule is inverted on purpose. Sprig caps every pivot with a DISC, which is
 * exactly right for capsule limbs and exactly wrong here - a round cap on a
 * straight limb reads as a bead of solder and destroys the whole premise. So
 * Flint uses a mitered joint PLATE instead: a small diamond at each pivot, large
 * enough that a bend cannot open a wedge, angular enough to look like part of
 * the same crystal.
 *
 * Usage: new Flint('#stage', { theme: 'dark' })
 *        f.setState('walk' | 'idle' | 'wave' | 'idea' | 'sleep')
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  // MindSpark's own tokens (public/styles.css), inverted for dark grounds for
  // the reason sprig.js documents. The EMBER never inverts: it is a light
  // source, and a light source that changes colour with the wallpaper stops
  // reading as light.
  const THEMES = {
    // `core` and `glow` are the ember, and they are the one pair that cannot
    // simply be inverted. A glow has to fall off from a hot centre outward, so
    // the CORE must be the lightest value and the halo a step behind it. Paint
    // both in the accent and a dark ground gets the falloff backwards: the halo
    // comes out lighter than the spark inside it, and the ember reads as a
    // scorch mark with a hole in the middle.
    light: { ink: '#23201b', inkSoft: '#3a352c', facet: '#4a443a', face: '#f4efe6',
             eye: '#23201b', accent: '#e0613a', teal: '#2f6f6a',
             core: '#e0613a', glow: '#e0613a' },
    dark:  { ink: '#e6e0d3', inkSoft: '#cdc6b6', facet: '#a49c8c', face: '#fbf8f2',
             eye: '#23201b', accent: '#e0613a', teal: '#4ec9b0',
             core: '#ffcaa6', glow: '#ff8a5b' }
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ------------------------------------------------------------------ geometry
  // One 200x250 stage, matching sprig.js and nib.js so the three can be
  // compared at the same size.
  const G = {
    shoulder: { l: { x: 68, y: 128 }, r: { x: 132, y: 128 } },
    hip: { l: { x: 84, y: 176 }, r: { x: 116, y: 176 } },
    arm: { upper: 22, fore: 20, w: 8, hand: 7 },
    // upper + fore has to span hip to ground (176 -> 232) or the feet hang in
    // the air above their own shadow, which reads as a bug rather than a hover.
    leg: { upper: 27, fore: 25, w: 10, hand: 9 },
    crown: { x: 100, y: 92 },
    ground: 232
  };

  // The crystal. Six vertices, widest just above the middle, so it sits rather
  // than floats. Kept asymmetric by two units on the right: a perfectly
  // symmetrical gem reads as a UI icon, not as a creature.
  const BODY_PTS = '100,90 136,122 128,178 100,202 72,178 64,120';

  /**
   * One angular limb: upper -> fore -> hand, mitered, with a diamond joint
   * plate at each pivot. Straight segments and butt caps throughout - see the
   * header for why a round cap cannot appear anywhere on this character.
   */
  function limb(parent, at, spec, colour) {
    const g = el('g', { transform: `translate(${at.x} ${at.y})` }, parent);
    const upper = el('g', null, g);
    const plate = (p, r) => el('polygon', {
      points: `0,${-r} ${r},0 0,${r} ${-r},0`, fill: colour
    }, p);
    plate(upper, spec.w * 0.62);
    el('line', { x1: 0, y1: 0, x2: 0, y2: spec.upper, stroke: colour,
                 'stroke-width': spec.w, 'stroke-linecap': 'butt' }, upper);
    const fore = el('g', { transform: `translate(0 ${spec.upper})` }, upper);
    plate(fore, spec.w * 0.6);
    el('line', { x1: 0, y1: 0, x2: 0, y2: spec.fore, stroke: colour,
                 'stroke-width': spec.w * 0.85, 'stroke-linecap': 'butt' }, fore);
    const cap = el('g', { transform: `translate(0 ${spec.fore})` }, fore);
    return { g, upper, fore, cap };
  }

  function build(p, C) {
    const id = n => p + '-' + n;
    const svg = el('svg', { viewBox: '0 0 200 250', role: 'img',
                            preserveAspectRatio: 'xMidYMid meet' });
    el('title', null, svg).textContent = 'Flint - a MindSpark mascot';
    const root = el('g', { id: id('root') }, svg);

    // Contact shadow. The one ellipse in the file, and it is not part of the
    // character: cast light on a flat page is round whatever is casting it.
    const shadow = el('ellipse', { cx: 100, cy: G.ground + 2, rx: 36, ry: 6.5,
                                   fill: C.ink, opacity: 0.16 }, root);

    const bob = el('g', { id: id('bob') }, root);

    // ---- legs, behind the body ----
    const legL = limb(bob, G.hip.l, G.leg, C.facet);
    const legR = limb(bob, G.hip.r, G.leg, C.ink);
    [legL, legR].forEach(L => {
      el('polygon', { points: '-9,-2 9,-2 12,5 -12,5', fill: L === legR ? C.ink : C.facet }, L.cap);
    });

    // ---- far arm, behind the body ----
    const armL = limb(bob, G.shoulder.l, G.arm, C.facet);
    el('polygon', { points: '0,-7 7,0 0,7 -7,0', fill: C.facet }, armL.cap);

    // ---- the crystal ----
    const bodyG = el('g', { id: id('body') }, bob);
    el('polygon', { points: BODY_PTS, fill: C.ink }, bodyG);
    // Facets. Two lighter planes and one teal, all straight-edged, so the shard
    // has a direction of light rather than being a flat sticker.
    el('polygon', { points: '100,90 136,122 100,168', fill: C.inkSoft, opacity: 0.55 }, bodyG);
    el('polygon', { points: '128,178 100,202 100,168', fill: C.teal, opacity: 0.38 }, bodyG);
    el('polygon', { points: '64,120 100,168 72,178', fill: C.facet, opacity: 0.35 }, bodyG);
    // the face plane: a kite, not an ellipse
    el('polygon', { points: '100,102 124,124 100,164 76,124', fill: C.face }, bodyG);

    const eyes = el('g', { id: id('eyes') }, bodyG);
    // Angular eyes. A circle here would be the one soft thing on the character
    // and the eye is exactly where that gets noticed.
    // Mirrored, not copied: two eyes tilted the SAME way read as a face that is
    // sneering. Each one drops toward the outside of the head instead.
    [[-1, 88], [1, 112]].forEach(([dir, x]) => {
      const ge = el('g', null, eyes);
      const o = 1.6 * dir;
      el('polygon', {
        points: `${x - 5},${129 + o} ${x + 5},${129 - o} ${x + 5},${137 - o} ${x - 5},${137 + o}`,
        fill: C.eye
      }, ge);
      el('polygon', { points: `${x - 3},${130 + o} ${x},${130} ${x},${133} ${x - 3},${133 + o}`,
                      fill: '#ffffff', opacity: 0.9 }, ge);
    });
    const mouth = el('polyline', { points: '93,148 100,152 107,148', fill: 'none',
                                   stroke: C.eye, 'stroke-width': 2.2,
                                   'stroke-linejoin': 'miter', 'stroke-linecap': 'butt' }, bodyG);

    // ---- near arm, in front ----
    const armR = limb(bob, G.shoulder.r, G.arm, C.ink);
    el('polygon', { points: '0,-7 7,0 0,7 -7,0', fill: C.ink }, armR.cap);

    // ---- the ember: the whole point of the character ----
    // Off the body entirely, so it can travel. Three stacked shapes give it a
    // falloff without a gradient: two soft halos and a hard four-point spark,
    // which is MindSpark's own mark at the centre of its own mascot.
    const emberG = el('g', { id: id('ember') }, root);
    const halo2 = el('circle', { cx: 0, cy: 0, r: 16, fill: C.glow, opacity: 0.12 }, emberG);
    const halo1 = el('circle', { cx: 0, cy: 0, r: 9, fill: C.glow, opacity: 0.3 }, emberG);
    // The four-point spark at the centre is MindSpark's own mark, at the centre
    // of its own mascot. That is the whole argument for this character.
    const core = el('path', {
      d: 'M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2 Z', fill: C.core
    }, emberG);
    // the trail the ember leaves when it moves fast
    const wake = el('path', { fill: 'none', stroke: C.core, 'stroke-width': 3,
                              'stroke-linecap': 'round', opacity: 0 }, root);

    const sparkG = el('g', { id: id('spark'), opacity: 0 }, root);
    const sparks = [];
    for (let i = 0; i < 6; i++) {
      sparks.push(el('polygon', { points: '0,-3 1,-1 3,0 1,1 0,3 -1,1 -3,0 -1,-1',
                                  fill: C.core }, sparkG));
    }

    return { svg, root, bob, bodyG, shadow, eyes, mouth,
             emberG, core, halo1, halo2, wake, sparkG, sparks,
             armL, armR, legL, legR };
  }

  // ----------------------------------------------------------------- animation

  function poseLimb(L, upperDeg, foreDeg, spec) {
    L.upper.setAttribute('transform', `rotate(${upperDeg.toFixed(2)})`);
    L.fore.setAttribute('transform', `translate(0 ${spec.upper}) rotate(${foreDeg.toFixed(2)})`);
  }

  const STATES = ['idle', 'walk', 'wave', 'idea', 'sleep'];

  class Flint {
    constructor(container, opts) {
      opts = opts || {};
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('Flint: container not found');

      this.C = THEMES[opts.theme === 'dark' ? 'dark' : 'light'];
      this.h = build('fl' + (Flint._seq = (Flint._seq || 0) + 1), this.C);
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', 'Flint, a MindSpark mascot');
      if (opts.width) this.svg.setAttribute('width', opts.width);
      this.container.appendChild(this.svg);

      this.t = 0;
      this.state = opts.state || 'idle';
      this.stateT = 0;
      this.blinkIn = 1.4 + Math.random() * 2.6;
      this.blinkT = -1;
      this.walkPhase = 0;
      // The ember is simulated, not keyframed: every state sets a TARGET and the
      // mote eases toward it. That is what makes it read as a thing with its own
      // momentum rather than a sprite being teleported between poses.
      this.ex = 138; this.ey = 96;
      this.evx = 0; this.evy = 0;
      this.trail = [];
      this.running = false;
      this._raf = 0;
      this._prev = 0;
      this.sparkT = -1;
      this._render(0);
      if (opts.autoStart !== false) this.start();
    }

    setState(s) {
      if (STATES.indexOf(s) < 0) return this;
      this.state = s;
      this.stateT = 0;
      if (s === 'idea') this.sparkT = 0;
      return this;
    }

    start() {
      if (this.running) return this;
      this.running = true;
      this._prev = 0;
      const loop = ts => {
        if (!this.running) return;
        const dt = this._prev ? Math.min((ts - this._prev) / 1000, 0.05) : 0;
        this._prev = ts;
        this.t += dt;
        this.stateT += dt;
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

    destroy() {
      this.pause();
      if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
      return this;
    }

    _render(dt) {
      const h = this.h, t = this.t, s = this.state;
      const breathe = Math.sin(t * 1.5) * 0.7;

      let bobY = breathe, lean = 0;
      // SIGN CONVENTION (the bug sprig.js records): SVG rotate(+deg) is
      // clockwise, so outward is NEGATIVE for the right limbs, POSITIVE for the
      // left. Backwards, both arms tuck into the silhouette and vanish.
      let armRU = -24, armRF = -14, armLU = 24, armLF = 14;
      let legLU = 0, legLF = 0, legRU = 0, legRF = 0;
      let lidAmt = 0, mouthLift = 0;
      // ember: target position, size and heat
      // The orbit is a ring ABOVE the crown (body top is y 90), never across the
      // face: a light source crossing its own object stops being a light source
      // and becomes a sticker.
      let tx = 100 + Math.cos(t * 0.9) * 46, ty = 66 + Math.sin(t * 0.9) * 15;
      let heat = 1, k = 6;

      if (s === 'walk') {
        this.walkPhase = (this.walkPhase + dt / 0.6) % 1;
        const a = Math.PI * 2 * this.walkPhase;
        legLU = Math.sin(a) * 25;
        legRU = Math.sin(a + Math.PI) * 25;
        legLF = Math.max(0, Math.sin(a - 0.9)) * 24;
        legRF = Math.max(0, Math.sin(a + Math.PI - 0.9)) * 24;
        armRU = -(20 + Math.sin(a) * 15);
        armLU = 20 + Math.sin(a + Math.PI) * 15;
        armRF = -(12 + Math.max(0, Math.sin(a - 0.7)) * 15);
        armLF = 12 + Math.max(0, Math.sin(a + Math.PI - 0.7)) * 15;
        bobY = breathe - Math.abs(Math.sin(a * 2)) * 2.4;
        lean = 4;
        // The ember gets left behind and has to catch up: it drags at the
        // shoulder rather than orbiting, which is what sells a walk as motion
        // through space when the body is standing still on a 200px stage.
        // BEHIND, not in front. lean is +4 (clockwise, leaning right), so Flint
        // is travelling right and the ember has to be the thing catching up.
        tx = 48; ty = 98 + Math.sin(a) * 7;
        k = 3.2;
      } else if (s === 'wave') {
        const q = Math.min(1, this.stateT / 0.35);
        const sw = Math.sin(t * 6.4);
        armRU = lerp(-24, -118, q * q * (3 - 2 * q)) + sw * 4;
        armRF = lerp(-14, -26, q) + Math.sin(t * 6.4 - 0.5) * 20;
        armLU = 22; armLF = 16;
        lean = -3;
        mouthLift = 1;
        lidAmt = 0.25;
        // The ember waves too, in a wide arc above the raised arm. Two things
        // waving in sync is what makes it read as one gesture rather than an
        // arm moving while a bug flies past.
        tx = 148 + sw * 26; ty = 74 - Math.abs(sw) * 10;
        k = 9;
        heat = 1.15;
      } else if (s === 'idea') {
        const q = clamp(this.stateT / 0.3, 0, 1);
        bobY = breathe - Math.sin(Math.min(1, this.stateT / 0.5) * Math.PI) * 5;
        armRU = -(24 + 72 * q); armLU = 24 + 72 * q;
        armRF = -(14 + 18 * q); armLF = 14 + 18 * q;
        mouthLift = 1;
        // The ember snaps to dead centre above the crown and flares. Straight
        // up is the only position that reads as "struck" rather than "drifting".
        tx = 100; ty = 52 - q * 6;
        k = 14;
        heat = 1 + 1.5 * q;
      } else if (s === 'sleep') {
        lidAmt = 1;
        bobY = Math.sin(t * 0.85) * 1.5;
        armRU = -30; armRF = -18; armLU = 30; armLF = 18;
        legLU = -4; legRU = 4;
        // burnt down to a coal, resting on the shoulder
        tx = 144; ty = 110 + Math.sin(t * 0.7) * 2;
        k = 2.2;
        heat = 0.3 + Math.sin(t * 1.3) * 0.07;
      } else {
        lean = Math.sin(t * 0.65) * 2;
        heat = 1 + Math.sin(t * 2.1) * 0.07;
      }

      // ---- ember integration: spring toward the target, never snap ----
      this.evx = this.evx * 0.86 + (tx - this.ex) * k * dt;
      this.evy = this.evy * 0.86 + (ty - this.ey) * k * dt;
      this.ex += this.evx; this.ey += this.evy;
      const speed = Math.hypot(this.evx, this.evy);

      h.bob.setAttribute('transform',
        `translate(0 ${bobY.toFixed(2)}) rotate(${lean.toFixed(2)} 100 ${G.ground})`);
      poseLimb(h.armR, armRU, armRF, G.arm);
      poseLimb(h.armL, armLU, armLF, G.arm);
      poseLimb(h.legL, legLU, legLF, G.leg);
      poseLimb(h.legR, legRU, legRF, G.leg);

      const lift = clamp(-bobY / 6, 0, 1);
      h.shadow.setAttribute('rx', (36 - lift * 8).toFixed(1));
      h.shadow.setAttribute('opacity', (0.15 - lift * 0.05).toFixed(3));

      // ---- the ember, drawn ----
      h.emberG.setAttribute('transform',
        `translate(${this.ex.toFixed(1)} ${this.ey.toFixed(1)}) rotate(${(t * 40).toFixed(1)})`);
      // Heat drives the CORE hard and the halo softly. Scaling both by heat is
      // what turned the idea flare into a pale cloud the size of the character:
      // a bright small thing reads as hot, a big dim thing reads as fog.
      // Range matters more than the midpoint: at 0.85 + 0.5h a burnt-down coal
      // was still very nearly full size, so asleep looked the same as awake.
      h.core.setAttribute('transform', `scale(${(0.5 + 0.55 * heat).toFixed(3)})`);
      h.core.setAttribute('opacity', clamp(0.5 + 0.5 * heat, 0.4, 1).toFixed(2));
      const halo = 0.7 + 0.3 * heat;
      h.halo1.setAttribute('r', (8 * halo).toFixed(1));
      h.halo2.setAttribute('r', (15 * halo).toFixed(1));
      h.halo1.setAttribute('opacity', clamp(0.34 * heat, 0, 0.5).toFixed(2));
      h.halo2.setAttribute('opacity', clamp(0.13 * heat, 0, 0.2).toFixed(2));

      // Wake: the last few positions, drawn as a line. Only visible above a
      // speed threshold, so a drifting ember is clean and a thrown one streaks.
      this.trail.push(this.ex, this.ey);
      if (this.trail.length > 16) this.trail.splice(0, this.trail.length - 16);
      if (speed > 0.9) {
        let d = '';
        for (let i = 0; i < this.trail.length; i += 2) {
          d += (d ? 'L' : 'M') + this.trail[i].toFixed(1) + ' ' + this.trail[i + 1].toFixed(1) + ' ';
        }
        h.wake.setAttribute('d', d);
        h.wake.setAttribute('opacity', clamp((speed - 0.9) * 0.5, 0, 0.5).toFixed(2));
      } else {
        h.wake.setAttribute('opacity', '0');
      }

      // ---- sparks, struck off the crystal ----
      if (this.sparkT >= 0) {
        this.sparkT += dt;
        const q = this.sparkT / 0.8;
        if (q >= 1) { this.sparkT = -1; h.sparkG.setAttribute('opacity', '0'); }
        else {
          h.sparkG.setAttribute('opacity', (1 - q).toFixed(2));
          h.sparks.forEach((sp, i) => {
            const a = (-Math.PI / 2) + (i - 2.5) * 0.36;
            const r = 10 + q * 44;
            const x = this.ex + Math.cos(a) * r;
            const y = this.ey + Math.sin(a) * r * 0.7 + q * q * 26;
            sp.setAttribute('transform',
              `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(1.4 * (1 - q)).toFixed(2)})`);
          });
        }
      }

      // ---- blink ----
      if (s !== 'sleep') {
        if (this.blinkT >= 0) {
          this.blinkT += dt;
          if (this.blinkT > 0.16) { this.blinkT = -1; this.blinkIn = 1.8 + Math.random() * 3; }
        } else if ((this.blinkIn -= dt) <= 0) this.blinkT = 0;
      }
      const blink = this.blinkT >= 0 ? Math.sin(Math.PI * (this.blinkT / 0.16)) : 0;
      const lid = Math.max(lidAmt, blink);
      h.eyes.setAttribute('transform',
        `translate(0 132) scale(1 ${(1 - 0.88 * lid).toFixed(3)}) translate(0 -132)`);
      // The mouth is a chevron: it inverts rather than curving, because a curve
      // is the one thing this character is not allowed to do.
      h.mouth.setAttribute('points', mouthLift
        ? '92,151 100,145 108,151'
        : '93,148 100,152 107,148');
    }
  }

  Flint.STATES = STATES;
  Flint.THEMES = THEMES;
  global.Flint = Flint;
  if (typeof module !== 'undefined' && module.exports) module.exports = Flint;
})(typeof window !== 'undefined' ? window : this);
