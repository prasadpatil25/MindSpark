/**
 * nib.js - Nib, a mascot candidate for MindSpark.
 *
 * WHY THIS SHAPE
 * --------------
 * Sprig (sprig.js) argues that MindSpark's irreducible idea is a thought that
 * forks, and wears the fork as an antenna. Nib argues something narrower and
 * harder: the app is not a diagram viewer, it is a thing you WRITE with. So Nib
 * is a fountain pen nib that stands on its own point, and its signature is not
 * an appendage at all - it is the LINE IT LEAVES BEHIND. The trail is the
 * branch. When Nib has an idea the trail forks and buds, which is the exact
 * gesture the product performs when you press Tab.
 *
 * That is the strongest concept of the three and the hardest to make cute: a
 * nib is a metal wedge with no face, no limbs and no round edges. Three moves
 * buy it back, all of them borrowed from the real object rather than invented:
 *   - the SHOULDERS of a nib are called shoulders, so that is where the arms go;
 *   - the BREATHER HOLE reads as a face feature the moment there are eyes above
 *     it, so the anatomy does the cartooning for free;
 *   - standing on the point means it never walks. It hovers and pivots, which
 *     is lighter and less puppet-like than four limbs would be.
 *
 * At 32px on a minimap what survives is a dark wedge over a terracotta line.
 * That is enough: no other mascot in this folder has a line under it.
 *
 * WHY IT IS BUILT LIKE THIS
 * -------------------------
 * Same construction rules as sprig.js, for the same reasons: every part is its
 * own element (no masks, no re-extracting limbs from a closed outline the way
 * cat-rig.js has to), a JOINT CAP at every pivot so a bend cannot open a wedge,
 * and LAG down every chain - the forearm behind the upper arm, the trail behind
 * the body. Motion that arrives everywhere at once reads as a puppet.
 *
 * The one thing here that Sprig does not have is a path that is REDRAWN each
 * frame rather than posed. The trail is a real <path> whose d is rebuilt from a
 * scrolling phase, because a dash-offset trick cannot fork.
 *
 * Usage: new Nib('#stage', { theme: 'dark' })
 *        n.setState('walk' | 'idle' | 'wave' | 'idea' | 'sleep')
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  // MindSpark's own tokens (public/styles.css). Nib INVERTS with the theme for
  // the reason sprig.js documents: the app ships ten themes and an ink-black
  // body is invisible on #1e1e1e. What stays fixed is the RELATIONSHIP - body
  // one step off the page, face plate one step lighter again, ink line
  // unchanged - so it is one character in two lights, not two characters.
  const THEMES = {
    light: { ink: '#23201b', inkSoft: '#3a352c', face: '#f4efe6', eye: '#23201b',
             glint: '#ffffff', accent: '#e0613a', teal: '#2f6f6a', paper: '#f4efe6' },
    dark:  { ink: '#e6e0d3', inkSoft: '#cdc6b6', face: '#fbf8f2', eye: '#23201b',
             glint: '#ffffff', accent: '#e0613a', teal: '#4ec9b0', paper: '#1e1e1e' }
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ------------------------------------------------------------------ geometry
  // One 200x250 stage, matching sprig.js so the two can be compared at size.
  // The paper line is y 214: that is where the point rides and where the trail
  // is drawn. The ground shadow is below it at 232.
  const G = {
    tip: { x: 100, y: 206 },        // the point, in body coordinates
    // The line sits 4 units under the point, not 8. At 8 the nib visibly
    // hovers over its own trail and the whole premise (this thing is writing
    // that line) stops reading.
    line: 210,
    ground: 222,
    shoulder: { l: { x: 64, y: 122 }, r: { x: 136, y: 122 } },
    arm: { upper: 21, fore: 19, w: 8.5, hand: 6.4 }
  };

  // The nib outline. A real nib is a shield: flat-ish crown, straight shoulders,
  // then two long concave flanks meeting at a point. Keeping the flanks CONCAVE
  // is what makes it read as a nib rather than a leaf or a shield badge.
  const BODY_D =
    'M76 97 L124 97 C132 97 138 103 138 112 L138 132 ' +
    'C138 160 122 188 100 207 C78 188 62 160 62 132 L62 112 ' +
    'C62 103 68 97 76 97 Z';

  /** One arm: upper -> fore -> hand cap, one rotate per joint. */
  function limb(parent, at, spec, colour) {
    const g = el('g', { transform: `translate(${at.x} ${at.y})` }, parent);
    const upper = el('g', null, g);
    el('circle', { cx: 0, cy: 0, r: spec.w / 2, fill: colour }, upper);
    el('line', { x1: 0, y1: 0, x2: 0, y2: spec.upper, stroke: colour,
                 'stroke-width': spec.w, 'stroke-linecap': 'round' }, upper);
    const fore = el('g', { transform: `translate(0 ${spec.upper})` }, upper);
    el('circle', { cx: 0, cy: 0, r: spec.w / 2, fill: colour }, fore);
    el('line', { x1: 0, y1: 0, x2: 0, y2: spec.fore, stroke: colour,
                 'stroke-width': spec.w * 0.88, 'stroke-linecap': 'round' }, fore);
    const cap = el('g', { transform: `translate(0 ${spec.fore})` }, fore);
    el('circle', { cx: 0, cy: 0, r: spec.hand, fill: colour }, cap);
    return { g, upper, fore, cap };
  }

  function build(p, C) {
    const id = n => p + '-' + n;
    const svg = el('svg', { viewBox: '0 0 200 250', role: 'img',
                            preserveAspectRatio: 'xMidYMid meet' });
    el('title', null, svg).textContent = 'Nib - a MindSpark mascot';
    const root = el('g', { id: id('root') }, svg);

    // Contact shadow FIRST, so the written line lies on top of it. Drawn after,
    // it crosses the trail as a grey smudge and the line stops reading as ink
    // on a page.
    const shadow = el('ellipse', { cx: 100, cy: G.ground, rx: 20, ry: 4.5,
                                   fill: C.ink, opacity: 0.13 }, root);

    // ---- the trail, over the shadow and behind the body: this is the character ----
    // Two layers: the line already written (solid) and the fork it grows on an
    // idea. Both are rebuilt per frame, so they are declared empty here.
    const trailG = el('g', { id: id('trail') }, root);
    const trail = el('path', {
      fill: 'none', stroke: C.accent, 'stroke-width': 4.2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }, trailG);
    // Nodes the line has already dropped, scrolling away to the left. Three is
    // enough to read as a branch without turning the stage into a diagram.
    const dots = [];
    for (let i = 0; i < 3; i++) {
      dots.push(el('circle', { cx: -20, cy: G.line, r: 5, fill: C.accent }, trailG));
    }
    const forkG = el('g', { id: id('fork'), opacity: 0 }, trailG);
    const forkUp = el('path', { fill: 'none', stroke: C.accent, 'stroke-width': 4,
                                'stroke-linecap': 'round' }, forkG);
    const forkDn = el('path', { fill: 'none', stroke: C.teal, 'stroke-width': 4,
                                'stroke-linecap': 'round' }, forkG);
    const budUp = el('circle', { r: 7, fill: C.accent }, forkG);
    const budDn = el('circle', { r: 7, fill: C.teal }, forkG);

    // ---- the body, hanging from a pivot AT THE POINT ----
    // Everything rotates about the tip, not the centre: a pen pivots where it
    // touches the paper, and rotating about the middle instantly reads as a
    // floating badge instead.
    const bob = el('g', { id: id('bob') }, root);
    const tilt = el('g', { id: id('tilt') }, bob);

    const armL = limb(tilt, G.shoulder.l, G.arm, C.inkSoft);
    const bodyG = el('g', { id: id('body') }, tilt);
    el('path', { d: BODY_D, fill: C.ink }, bodyG);

    // face plate: the flat crown of the nib, one step lighter than the body
    el('ellipse', { cx: 100, cy: 129, rx: 29, ry: 23, fill: C.face }, bodyG);
    const eyes = el('g', { id: id('eyes') }, bodyG);
    [[89, 126], [111, 126]].forEach(([x, y]) => {
      const ge = el('g', null, eyes);
      el('circle', { cx: x, cy: y, r: 5.2, fill: C.eye }, ge);
      el('circle', { cx: x - 1.8, cy: y - 2, r: 1.8, fill: C.glint }, ge);
    });
    el('ellipse', { cx: 78, cy: 138, rx: 5.4, ry: 3.2, fill: C.accent, opacity: 0.45 }, bodyG);
    el('ellipse', { cx: 122, cy: 138, rx: 5.4, ry: 3.2, fill: C.accent, opacity: 0.45 }, bodyG);
    const mouth = el('path', { d: 'M94 141 Q100 146 106 141', fill: 'none',
                               stroke: C.eye, 'stroke-width': 2, 'stroke-linecap': 'round' }, bodyG);

    // breather hole + slit: the two details that make it a nib and not a leaf.
    // The hole is filled with the PAGE colour rather than the face colour, so it
    // reads as a hole through the metal instead of a painted dot.
    el('circle', { cx: 100, cy: 159, r: 7, fill: C.paper }, bodyG);
    el('path', { d: 'M100 169 L100 202', stroke: C.paper, 'stroke-width': 3.2,
                 'stroke-linecap': 'round' }, bodyG);
    // a highlight down one flank, so the wedge reads as metal
    el('path', { d: 'M84 112 C76 132 78 160 92 186', fill: 'none',
                 stroke: C.face, 'stroke-width': 2.4, opacity: 0.22,
                 'stroke-linecap': 'round' }, bodyG);

    // the ink bead that gathers at the point when Nib is idle or asleep
    const bead = el('ellipse', { cx: 100, cy: 205, rx: 3.4, ry: 4.4,
                                 fill: C.accent, opacity: 0 }, tilt);

    const armR = limb(tilt, G.shoulder.r, G.arm, C.ink);

    // sparks, thrown from the tip on an idea
    const sparkG = el('g', { id: id('spark'), opacity: 0 }, root);
    const sparks = [];
    for (let i = 0; i < 5; i++) {
      sparks.push(el('circle', { cx: 100, cy: G.line, r: 2.6, fill: C.accent }, sparkG));
    }

    return { svg, root, bob, tilt, bodyG, shadow, eyes, mouth, bead,
             trail, dots, forkG, forkUp, forkDn, budUp, budDn,
             armL, armR, sparkG, sparks };
  }

  // ----------------------------------------------------------------- animation

  function poseLimb(L, upperDeg, foreDeg, spec) {
    L.upper.setAttribute('transform', `rotate(${upperDeg.toFixed(2)})`);
    L.fore.setAttribute('transform', `translate(0 ${spec.upper}) rotate(${foreDeg.toFixed(2)})`);
  }

  const STATES = ['idle', 'walk', 'wave', 'idea', 'sleep'];

  class Nib {
    constructor(container, opts) {
      opts = opts || {};
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('Nib: container not found');

      this.C = THEMES[opts.theme === 'dark' ? 'dark' : 'light'];
      this.h = build('nb' + (Nib._seq = (Nib._seq || 0) + 1), this.C);
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', 'Nib, a MindSpark mascot');
      if (opts.width) this.svg.setAttribute('width', opts.width);
      this.container.appendChild(this.svg);

      this.t = 0;
      this.state = opts.state || 'idle';
      this.stateT = 0;
      this.blinkIn = 1.4 + Math.random() * 2.6;
      this.blinkT = -1;
      this.scroll = 0;        // how far the written line has travelled
      this.tiltLag = 0;       // the body trails its own target angle
      this.tiltVel = 0;
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

    /**
     * The written line. Rebuilt per frame from `scroll` so the wave travels
     * leftward under a stationary nib: the illusion is that the page moves, the
     * way it does when you actually write. `amp` flattens the line when Nib is
     * not writing, so idle does not look like it is drawing nothing.
     */
    _trailPath(amp) {
      const y = G.line, x0 = 8, x1 = G.tip.x;
      let d = '';
      for (let x = x0; x <= x1; x += 8) {
        const yy = y + Math.sin((x + this.scroll) * 0.055) * amp;
        d += (d ? 'L' : 'M') + x.toFixed(1) + ' ' + yy.toFixed(1) + ' ';
      }
      return d;
    }

    _render(dt) {
      const h = this.h, t = this.t, s = this.state;
      const breathe = Math.sin(t * 1.7) * 0.8;

      let bobY = breathe, tiltTo = 0, lift = 0, amp = 1.2, speed = 0;
      // SIGN CONVENTION (the bug sprig.js records): SVG rotate(+deg) is
      // clockwise, so on a limb hanging straight down, positive swings it toward
      // -x. Outward is NEGATIVE for the right arm and POSITIVE for the left.
      let armRU = -30, armRF = -18, armLU = 30, armLF = 18;
      let lidAmt = 0, mouthW = 1, beadOn = 0;

      if (s === 'walk') {
        // Nib does not have legs to walk on. It writes: the line scrolls, the
        // body leans into the stroke and rocks the way a hand does mid-word.
        speed = 78;
        amp = 5.5;
        // The page scrolls left, so Nib is travelling right, so it leans right:
        // rotate(+deg) is clockwise. Leaning the other way is the difference
        // between a pen being pushed along and a pen being dragged backwards.
        tiltTo = 7 + Math.sin(t * 7.5) * 2.2;
        bobY = breathe - Math.abs(Math.sin(t * 7.5)) * 1.6;
        armRU = -46 + Math.sin(t * 7.5) * 10;
        armLU = 40 + Math.sin(t * 7.5 + Math.PI) * 10;
        armRF = -26; armLF = 22;
      } else if (s === 'wave') {
        const q = Math.min(1, this.stateT / 0.35);
        const sw = Math.sin(t * 7.2), swLag = Math.sin(t * 7.2 - 0.5);
        // Shoulder holds, forearm does the wave, one beat behind it.
        armRU = lerp(-30, -126, q * q * (3 - 2 * q)) + sw * 4;
        armRF = lerp(-18, -30, q) + swLag * 22;
        armLU = 28; armLF = 20;
        tiltTo = 6;             // leans back on its point, like a bow
        mouthW = 1.35;
        lidAmt = 0.25;
        amp = 1.2;
      } else if (s === 'idea') {
        // The payoff: the line it was writing splits in two and buds. This is
        // the same gesture the app performs on Tab, which is the whole argument
        // for this character over the other two.
        const q = clamp(this.stateT / 0.3, 0, 1);
        lift = 10 * q;
        tiltTo = 0;
        bobY = breathe - Math.sin(Math.min(1, this.stateT / 0.55) * Math.PI) * 6;
        mouthW = 1.5;
        armRU = -(30 + 76 * q); armLU = 30 + 76 * q;
        armRF = -(18 + 18 * q); armLF = 18 + 18 * q;
        amp = 2.4;
      } else if (s === 'sleep') {
        tiltTo = -13;
        lidAmt = 1;
        bobY = Math.sin(t * 0.9) * 1.4;
        armRU = -22; armRF = -12; armLU = 22; armLF = 12;
        amp = 0.5;
        beadOn = 1;             // ink gathers at a resting point
      } else {
        tiltTo = Math.sin(t * 0.7) * 3;
        amp = 1.2;
        beadOn = 0.55 + Math.sin(t * 0.8) * 0.45;
      }

      // ---- the body lags its own target angle ----
      this.tiltVel = this.tiltVel * 0.82 + (tiltTo - this.tiltLag) * 0.22;
      this.tiltLag += this.tiltVel;

      this.scroll += speed * dt;
      h.trail.setAttribute('d', this._trailPath(amp));

      // Nodes already dropped on the line, scrolling out to the left. Modulo
      // keeps three of them recycling instead of allocating forever.
      const span = 62;
      h.dots.forEach((dcircle, i) => {
        const x = 100 - (((this.scroll + i * span) % (span * 3)) + 4);
        const on = x > 6 ? 1 : 0;
        dcircle.setAttribute('cx', x.toFixed(1));
        dcircle.setAttribute('cy', (G.line + Math.sin((x + this.scroll) * 0.055) * amp).toFixed(1));
        dcircle.setAttribute('opacity', (on * 0.9).toFixed(2));
      });

      // pivot at the point, not the centre
      h.bob.setAttribute('transform', `translate(0 ${(bobY - lift).toFixed(2)})`);
      h.tilt.setAttribute('transform',
        `rotate(${this.tiltLag.toFixed(2)} ${G.tip.x} ${G.tip.y})`);

      poseLimb(h.armR, armRU, armRF, G.arm);
      poseLimb(h.armL, armLU, armLF, G.arm);
      h.bead.setAttribute('opacity', (beadOn * 0.85).toFixed(2));

      const off = clamp((lift - bobY) / 8, 0, 1);
      h.shadow.setAttribute('rx', (20 - off * 5).toFixed(1));
      h.shadow.setAttribute('opacity', (0.13 - off * 0.05).toFixed(3));

      // ---- the fork, only while there is an idea ----
      const q = s === 'idea' ? clamp(this.stateT / 0.42, 0, 1) : 0;
      h.forkG.setAttribute('opacity', q.toFixed(2));
      if (q > 0) {
        const e = q * q * (3 - 2 * q);          // smoothstep, so it grows rather than pops
        // Forward, into clean page, not back over what is already written: a
        // branch grows where the pen is going. It also puts the Y the right way
        // round, which is the shape the app draws when you press Tab.
        const x0 = 100, y0 = G.line;
        const ux = x0 + 46 * e, uy = y0 - 32 * e;
        const dx = x0 + 46 * e, dy = y0 + 26 * e;
        h.forkUp.setAttribute('d', `M${x0} ${y0} C${x0 + 22} ${y0} ${ux - 14} ${uy} ${ux} ${uy}`);
        h.forkDn.setAttribute('d', `M${x0} ${y0} C${x0 + 22} ${y0} ${dx - 14} ${dy} ${dx} ${dy}`);
        h.budUp.setAttribute('cx', ux.toFixed(1)); h.budUp.setAttribute('cy', uy.toFixed(1));
        h.budDn.setAttribute('cx', dx.toFixed(1)); h.budDn.setAttribute('cy', dy.toFixed(1));
        h.budUp.setAttribute('r', (7 * e).toFixed(2));
        h.budDn.setAttribute('r', (7 * e).toFixed(2));
      }

      // ---- sparks off the tip ----
      if (this.sparkT >= 0) {
        this.sparkT += dt;
        const sq = this.sparkT / 0.75;
        if (sq >= 1) { this.sparkT = -1; h.sparkG.setAttribute('opacity', '0'); }
        else {
          h.sparkG.setAttribute('opacity', (1 - sq).toFixed(2));
          h.sparks.forEach((sp, i) => {
            const a = (-Math.PI / 2) + (i - 2) * 0.4;
            const r = 12 + sq * 38;
            sp.setAttribute('cx', (100 + Math.cos(a) * r).toFixed(1));
            sp.setAttribute('cy', (G.line - 14 + Math.sin(a) * r * 0.6 + sq * sq * 20).toFixed(1));
            sp.setAttribute('r', (2.8 * (1 - sq)).toFixed(2));
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
        `translate(0 126) scale(1 ${(1 - 0.88 * lid).toFixed(3)}) translate(0 -126)`);
      h.mouth.setAttribute('transform',
        `translate(100 143) scale(${mouthW.toFixed(3)} ${(1 + (mouthW - 1) * 1.4).toFixed(3)}) translate(-100 -143)`);
    }
  }

  Nib.STATES = STATES;
  Nib.THEMES = THEMES;
  global.Nib = Nib;
  if (typeof module !== 'undefined' && module.exports) module.exports = Nib;
})(typeof window !== 'undefined' ? window : this);
