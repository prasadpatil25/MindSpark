/**
 * sprig.js - Sprig, an original mascot for MindSpark.
 *
 * WHY THIS SHAPE
 * --------------
 * MindSpark's one irreducible idea is a thought that forks. So Sprig's
 * silhouette is a soft ink pebble with a stem that FORKS INTO TWO, each prong
 * carrying a bud - terracotta on one side, teal on the other, straight out of
 * the app's own palette. Read at 16px on the minimap all you see is a dark bean
 * with a little Y on top, and that Y is the product's logo-shaped tell. Nothing
 * about it borrows from anyone: no cat, no octopus, no animal at all.
 *
 * The fork is also the expressive part. Real mascots emote with one appendage
 * (ears, antennae, a tail); Sprig emotes with the branch, which is the thing the
 * app is about. It perks when curious, droops when idle, splits a THIRD prong
 * when it has an idea, and trails behind the body when walking.
 *
 * WHY IT IS BUILT LIKE THIS
 * -------------------------
 * cat-rig.js in this repo fights a hard problem: the Octocat is one closed
 * subpath, so every limb has to be re-extracted from the outline, masked out of
 * the body, and fenced with clip windows, joint discs and protected bands before
 * it can move a degree. All of that machinery exists to undo a drawing decision.
 *
 * Sprig is drawn the other way round: every part is its own element from the
 * start. A limb is two capsules and a cap, parented shoulder -> elbow -> hand,
 * so posing it is one rotate per joint and there is no seam anywhere to tear.
 * That is why this file is a fraction of the size and has no mask in it.
 *
 * Two things are carried over from the cat, because they were the right ideas:
 *   - a JOINT CAP at every pivot, so a bend never opens a wedge;
 *   - LAG. The fork reads one beat behind the body, the forearm behind the upper
 *     arm, the hand behind the forearm. Motion that travels down a chain reads
 *     as one living thing; motion that arrives everywhere at once reads as a
 *     puppet snapping between poses.
 *
 * Usage: new Sprig('#stage', { scale: 1 })
 *        s.setState('walk' | 'idle' | 'wave' | 'idea' | 'sleep')
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (v, to, dt, k) => v + (to - v) * Math.min(1, dt * (k || 8));

  // MindSpark's own tokens (public/styles.css). Sprig INVERTS with the theme:
  // MindSpark ships ten of them, and an ink-black body is invisible on a #1e1e1e
  // ground. The relationship is what stays fixed - body one step off the page,
  // face one step lighter again, buds unchanged - so it reads as the same
  // character in ink on paper or chalk on slate, not as two mascots.
  const THEMES = {
    light: { ink: '#23201b', inkSoft: '#3a352c', face: '#f4efe6', eye: '#23201b',
             glint: '#ffffff', accent: '#e0613a', teal: '#2f6f6a' },
    dark:  { ink: '#e6e0d3', inkSoft: '#cdc6b6', face: '#fbf8f2', eye: '#23201b',
             glint: '#ffffff', accent: '#e0613a', teal: '#4ec9b0' }
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ------------------------------------------------------------------ geometry
  // One 200x250 stage. Ground is y 232; the body sits on it.
  const G = {
    bodyC: { x: 100, y: 148 },
    stemRoot: { x: 100, y: 104 },   // where the fork leaves the crown
    // Sockets sit ON the body's edge, not inside it. Tucked in, a limb spends
    // its first 10 units buried in the silhouette and reads as a stub.
    shoulder: { l: { x: 57, y: 139 }, r: { x: 143, y: 139 } },
    hip: { l: { x: 82, y: 191 }, r: { x: 118, y: 191 } },
    arm: { upper: 24, fore: 22, w: 9.5, hand: 7 },
    // same key names as `arm` - limb() reads spec.upper / spec.fore, and naming
    // these thigh/shin silently rendered y2="undefined" and collapsed the legs
    leg: { upper: 21, fore: 20, w: 11.5, foot: 9 },
    ground: 232
  };

  // Body: a bean, wider low, so it reads as standing rather than floating.
  const BODY_D =
    'M100 99 C127 99 147 120 147 148 C147 177 129 197 100 197 ' +
    'C71 197 53 177 53 148 C53 120 73 99 100 99 Z';

  /**
   * One limb: upper -> fore -> cap, each its own group so a pose is one rotate
   * per joint. `sign` is which way the limb hangs at rest.
   */
  function limb(parent, at, spec, sign, colour) {
    const g = el('g', { transform: `translate(${at.x} ${at.y})` }, parent);
    const upper = el('g', null, g);
    // joint cap at the shoulder - a bend can never open a wedge here
    el('circle', { cx: 0, cy: 0, r: spec.w / 2, fill: colour }, upper);
    el('line', {
      x1: 0, y1: 0, x2: 0, y2: spec.upper, stroke: colour,
      'stroke-width': spec.w, 'stroke-linecap': 'round'
    }, upper);
    const fore = el('g', { transform: `translate(0 ${spec.upper})` }, upper);
    el('circle', { cx: 0, cy: 0, r: spec.w / 2, fill: colour }, fore);
    el('line', {
      x1: 0, y1: 0, x2: 0, y2: spec.fore, stroke: colour,
      'stroke-width': spec.w * 0.88, 'stroke-linecap': 'round'
    }, fore);
    const cap = el('g', { transform: `translate(0 ${spec.fore})` }, fore);
    return { g, upper, fore, cap, sign };
  }

  function build(p, C) {
    const id = n => p + '-' + n;
    const svg = el('svg', {
      viewBox: '0 0 200 250', role: 'img',
      preserveAspectRatio: 'xMidYMid meet'
    });
    el('title', null, svg).textContent = 'Sprig - the MindSpark mascot';

    const root = el('g', { id: id('root') }, svg);

    // contact shadow, on the ground and not on the body, so a hop reads
    const shadow = el('ellipse', {
      cx: 100, cy: G.ground + 2, rx: 40, ry: 7,
      fill: C.ink, opacity: 0.16
    }, root);

    const bob = el('g', { id: id('bob') }, root);

    // ---- legs, behind the body ----
    const legL = limb(bob, G.hip.l, G.leg, -1, C.ink);
    const legR = limb(bob, G.hip.r, G.leg, 1, C.ink);
    [legL, legR].forEach(L => {
      el('ellipse', { cx: 0, cy: 1, rx: G.leg.foot, ry: 5.5, fill: C.ink }, L.cap);
    });

    // ---- the far arm, behind the body ----
    const armL = limb(bob, G.shoulder.l, G.arm, -1, C.inkSoft);
    el('circle', { cx: 0, cy: 0, r: G.arm.hand, fill: C.inkSoft }, armL.cap);

    // ---- body ----
    const bodyG = el('g', { id: id('body') }, bob);
    el('path', { d: BODY_D, fill: C.ink }, bodyG);

    // face patch + eyes
    el('ellipse', { cx: 100, cy: 143, rx: 33, ry: 29, fill: C.face }, bodyG);
    const eyes = el('g', { id: id('eyes') }, bodyG);
    const eyeL = el('g', null, eyes), eyeR = el('g', null, eyes);
    [[87, eyeL], [113, eyeR]].forEach(([x, ge]) => {
      el('circle', { cx: x, cy: 140, r: 5.6, fill: C.eye }, ge);
      el('circle', { cx: x - 1.9, cy: 138, r: 1.9, fill: C.glint }, ge);
    });
    const cheeks = el('g', { opacity: 0.5 }, bodyG);
    el('ellipse', { cx: 76, cy: 153, rx: 6, ry: 3.6, fill: C.accent, opacity: 0.45 }, cheeks);
    el('ellipse', { cx: 124, cy: 153, rx: 6, ry: 3.6, fill: C.accent, opacity: 0.45 }, cheeks);
    const mouth = el('path', {
      d: 'M94 155 Q100 160 106 155', fill: 'none', stroke: C.eye,
      'stroke-width': 2.1, 'stroke-linecap': 'round'
    }, bodyG);

    // ---- the fork: the whole point of the character ----
    // Its own group hanging off the crown so it can lag the body and flex.
    const forkG = el('g', { id: id('fork'), transform: `translate(${G.stemRoot.x} ${G.stemRoot.y})` }, bob);
    const forkFlex = el('g', null, forkG);
    // stem up to the split
    el('path', {
      d: 'M0 2 C0 -8 0 -18 0 -30', fill: 'none', stroke: C.ink,
      'stroke-width': 7, 'stroke-linecap': 'round'
    }, forkFlex);
    // the two prongs
    const prongL = el('g', null, forkFlex);
    el('path', {
      d: 'M0 -28 C-6 -42 -18 -50 -27 -58', fill: 'none', stroke: C.ink,
      'stroke-width': 5.4, 'stroke-linecap': 'round'
    }, prongL);
    const budL = el('circle', { cx: -27, cy: -58, r: 8, fill: C.accent }, prongL);
    const prongR = el('g', null, forkFlex);
    el('path', {
      d: 'M0 -28 C6 -40 17 -47 26 -54', fill: 'none', stroke: C.ink,
      'stroke-width': 5.4, 'stroke-linecap': 'round'
    }, prongR);
    const budR = el('circle', { cx: 26, cy: -54, r: 8, fill: C.teal }, prongR);
    // the third prong only exists when Sprig has an idea
    const prongIdea = el('g', { opacity: 0 }, forkFlex);
    el('path', {
      d: 'M0 -28 C1 -44 1 -54 0 -66', fill: 'none', stroke: C.ink,
      'stroke-width': 4.6, 'stroke-linecap': 'round'
    }, prongIdea);
    el('circle', { cx: 0, cy: -68, r: 6.4, fill: C.accent }, prongIdea);

    // the spark itself, thrown from the fork
    const sparkG = el('g', { id: id('spark'), opacity: 0 }, forkG);
    const sparks = [];
    for (let i = 0; i < 5; i++) {
      sparks.push(el('circle', { cx: 0, cy: -40, r: 2.6, fill: C.accent }, sparkG));
    }

    // ---- the near arm, in front of the body: this is the one that waves ----
    const armR = limb(bob, G.shoulder.r, G.arm, 1, C.ink);
    el('circle', { cx: 0, cy: 0, r: G.arm.hand, fill: C.ink }, armR.cap);

    return {
      svg, root, bob, bodyG, shadow, eyes, eyeL, eyeR, mouth, cheeks,
      forkG, forkFlex, prongL, prongR, prongIdea, budL, budR, sparkG, sparks,
      armL, armR, legL, legR
    };
  }

  // ----------------------------------------------------------------- animation

  function poseLimb(L, upperDeg, foreDeg, spec) {
    L.upper.setAttribute('transform', `rotate(${upperDeg.toFixed(2)})`);
    L.fore.setAttribute('transform', `translate(0 ${spec.upper}) rotate(${foreDeg.toFixed(2)})`);
  }

  const STATES = ['idle', 'walk', 'wave', 'idea', 'sleep'];

  class Sprig {
    constructor(container, opts) {
      opts = opts || {};
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('Sprig: container not found');

      this.C = THEMES[opts.theme === 'dark' ? 'dark' : 'light'];
      this.h = build('sp' + (Sprig._seq = (Sprig._seq || 0) + 1), this.C);
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', 'Sprig, the MindSpark mascot');
      if (opts.width) this.svg.setAttribute('width', opts.width);
      this.container.appendChild(this.svg);

      this.t = 0;
      this.state = opts.state || 'idle';
      this.stateT = 0;
      this.blinkIn = 1.4 + Math.random() * 2.6;
      this.blinkT = -1;
      this.walkPhase = 0;
      this.forkLag = 0;      // the fork trails the body - see the header
      this.forkVel = 0;
      this.lastLean = 0;
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
      const breathe = Math.sin(t * 1.6) * 0.9;

      let bobY = breathe, lean = 0, squash = 0;
      // SIGN CONVENTION: SVG rotate(+deg) is clockwise, so on a limb hanging
      // straight down a positive angle swings it toward -x. Outward is therefore
      // NEGATIVE for the right limbs and POSITIVE for the left. Getting this
      // backwards tucks both arms across the chest, where they vanish into the
      // silhouette - dark on dark - and only show when they cross the face.
      let armRU = -26, armRF = -16, armLU = 26, armLF = 16;
      let legLU = 0, legLF = 0, legRU = 0, legRF = 0;
      let forkPerk = 0, lidAmt = 0, mouthW = 1;

      if (s === 'walk') {
        this.walkPhase = (this.walkPhase + dt / 0.62) % 1;
        const a = TAU * this.walkPhase;
        // legs in antiphase; arms counter-swing against them
        legLU = Math.sin(a) * 26;
        legRU = Math.sin(a + Math.PI) * 26;
        legLF = Math.max(0, Math.sin(a - 0.9)) * 26;
        legRF = Math.max(0, Math.sin(a + Math.PI - 0.9)) * 26;
        armRU = -(22 + Math.sin(a) * 16);
        armLU = 22 + Math.sin(a + Math.PI) * 16;
        armRF = -(14 + Math.max(0, Math.sin(a - 0.7)) * 16);
        armLF = 14 + Math.max(0, Math.sin(a + Math.PI - 0.7)) * 16;
        bobY = breathe - Math.abs(Math.sin(a * 2)) * 2.6;
        lean = 5 + Math.sin(a * 2) * 1.5;
        squash = Math.abs(Math.sin(a * 2)) * 0.03;
        forkPerk = 2;
      } else if (s === 'wave') {
        // Shoulder holds; the FOREARM does the wave, lagging the shoulder.
        // A single rigid arm swinging from the shoulder reads as a board - the
        // lesson the cat rig had to learn the hard way.
        const q = Math.min(1, this.stateT / 0.35);
        const sw = Math.sin(t * 7.2);
        const swLag = Math.sin(t * 7.2 - 0.5);
        armRU = lerp(-26, -122, q * q * (3 - 2 * q)) + sw * 4;
        armRF = lerp(-16, -30, q) + swLag * 22;
        armLU = 24;
        armLF = 18;
        forkPerk = 7 + sw * 2.5;
        lean = -3;
        mouthW = 1.35;
        lidAmt = 0.25;
      } else if (s === 'idea') {
        // fork snaps upright, a third prong grows, sparks fly
        const q = clamp(this.stateT / 0.28, 0, 1);
        forkPerk = 13 * q;
        bobY = breathe - Math.sin(Math.min(1, this.stateT / 0.5) * Math.PI) * 5;
        mouthW = 1.5;
        armRU = -(26 + 74 * q);
        armLU = 26 + 74 * q;
        armRF = -(16 + 20 * q);
        armLF = 16 + 20 * q;
      } else if (s === 'sleep') {
        forkPerk = -16;
        lidAmt = 1;
        bobY = Math.sin(t * 0.9) * 1.6;
        armRU = -34; armRF = -24; armLU = 34; armLF = 24;
      } else {
        // idle: a small weight shift, so it never looks frozen
        lean = Math.sin(t * 0.7) * 2.2;
        forkPerk = Math.sin(t * 0.85 + 1) * 3;
      }

      // ---- the fork lags the body ----
      // Sprig's whole read depends on this: the branch arrives a beat after the
      // body it is attached to, the way anything springy does.
      const target = -lean * 0.9 + forkPerk;
      this.forkVel = this.forkVel * 0.82 + (target - this.forkLag) * 0.22;
      this.forkLag += this.forkVel;

      h.bob.setAttribute('transform',
        `translate(0 ${bobY.toFixed(2)}) rotate(${lean.toFixed(2)} 100 ${G.ground}) ` +
        `translate(100 ${G.ground}) scale(${(1 + squash).toFixed(4)} ${(1 - squash).toFixed(4)}) ` +
        `translate(-100 ${-G.ground})`);
      h.forkFlex.setAttribute('transform', `rotate(${this.forkLag.toFixed(2)})`);

      poseLimb(h.armR, armRU, armRF, G.arm);
      poseLimb(h.armL, armLU, armLF, G.arm);
      poseLimb(h.legL, legLU, legLF, G.leg);
      poseLimb(h.legR, legRU, legRF, G.leg);

      // shadow shrinks as the body rises - sells contact with the ground
      const lift = clamp(-bobY / 6, 0, 1);
      h.shadow.setAttribute('rx', (40 - lift * 9).toFixed(1));
      h.shadow.setAttribute('opacity', (0.13 - lift * 0.05).toFixed(3));

      // ---- third prong + sparks ----
      const ideaOn = s === 'idea' ? clamp(this.stateT / 0.22, 0, 1) : 0;
      h.prongIdea.setAttribute('opacity', ideaOn.toFixed(2));
      h.prongIdea.setAttribute('transform', `scale(${(0.5 + 0.5 * ideaOn).toFixed(3)})`);
      if (this.sparkT >= 0) {
        this.sparkT += dt;
        const q = this.sparkT / 0.75;
        if (q >= 1) { this.sparkT = -1; h.sparkG.setAttribute('opacity', '0'); }
        else {
          h.sparkG.setAttribute('opacity', (1 - q).toFixed(2));
          h.sparks.forEach((sp, i) => {
            const a = (-Math.PI / 2) + (i - 2) * 0.42;
            const r = 14 + q * 40;
            sp.setAttribute('cx', (Math.cos(a) * r).toFixed(1));
            sp.setAttribute('cy', (-44 + Math.sin(a) * r * 0.55 + q * q * 22).toFixed(1));
            sp.setAttribute('r', (2.8 * (1 - q)).toFixed(2));
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
        `translate(0 140) scale(1 ${(1 - 0.88 * lid).toFixed(3)}) translate(0 -140)`);

      h.mouth.setAttribute('transform',
        `translate(100 157) scale(${mouthW.toFixed(3)} ${(1 + (mouthW - 1) * 1.4).toFixed(3)}) translate(-100 -157)`);
    }
  }

  Sprig.STATES = STATES;
  Sprig.THEMES = THEMES;
  global.Sprig = Sprig;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sprig;
})(typeof window !== 'undefined' ? window : this);
