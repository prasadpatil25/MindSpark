/**
 * card-rig.js - Topic and Pip, the node-card mascots, rigged.
 *
 * WHY ONE FILE FOR TWO CHARACTERS
 * -------------------------------
 * sprig.js, nib.js and flint.js are three separate rigs because they are three
 * separate skeletons: a pebble with capsule limbs, a wedge that pivots on its
 * point, a crystal with mitered joints. Topic and Pip are not that. They are the
 * same skeleton at two sizes with three switches (antenna, tail, pill corners),
 * because they are the same thing in the product: a node, and its child.
 *
 * So this file is one rig and a SPEC table, not two files that would drift apart
 * the first time either of them was touched. Adding a third card character is a
 * new entry in SPECS, not a new copy of the animation code.
 *
 * WHY THE ARMS ARE CURVES AND NOT LIMBS
 * -------------------------------------
 * A jointed arm (shoulder -> elbow -> hand) is what the other three rigs use,
 * and it is wrong here. Topic's arms are BRANCH EDGES: in MindSpark a branch is
 * a curve leaving a card and ending at a child, so an arm is a quadratic from
 * the shoulder to the hand with a bend, and the hand is a child node. Posing it
 * means moving a point in space rather than solving two angles, which is both
 * simpler and more expressive - a hand can reach anywhere without the elbow
 * inverting, and the curve flexes on its own.
 *
 * HOW IT ANIMATES (and what is borrowed from Clawd)
 * -------------------------------------------------
 * Claude Code's mascot runs a scripted sequence of beats rather than reacting to
 * the page: look, walk, crouch, leap, repeat. That is the model here. Every
 * state is a target pose; a beat table (SCRIPT) strings them into a loop with
 * some jitter so it never plays the same bar twice in a row. Two details are
 * taken from it directly:
 *   - a GROUND CLIP, so a leg swung past the floor is cut off at the floor
 *     instead of hanging through it;
 *   - autonomy with no input. Cursor following is available (opts.follow) but
 *     off by default: a mascot that stares at the pointer is a toy, and one that
 *     lives its own life is a character.
 *
 * Every pose value is EASED toward its target rather than set, so states
 * cross-fade. Interrupting a wave halfway does not snap the arm back; it
 * arrives. That is the difference between twelve animations and twelve poses.
 *
 * Usage: new CardMascot('#stage', { character: 'topic', theme: 'dark' })
 *        m.setState('wave')      // one of CardMascot.STATES
 *        m.setAuto(true)         // run the beat loop
 *        m.look(-1, 0.3)         // aim the eyes, -1..1 in each axis
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  // Frame-rate independent easing: k is roughly "how many e-folds per second".
  const ease = (v, to, dt, k) => v + (to - v) * Math.min(1, dt * k);
  const rnd = (a, b) => a + Math.random() * (b - a);

  // MindSpark's tokens (public/styles.css). The card inverts with the theme for
  // the reason sprig.js documents; the spark never does, because it is the mark.
  const THEMES = {
    light: { ink: '#23201b', card: '#23201b', face: '#f4efe6', pupil: '#23201b',
             terra: '#e0613a', teal: '#2f6f6a', shadow: '#23201b' },
    dark:  { ink: '#e6e0d3', card: '#e6e0d3', face: '#1e1e1e', pupil: '#f4efe6',
             terra: '#e0613a', teal: '#4ec9b0', shadow: '#000000' }
  };

  // MindSpark's own mark, the exact path out of public/index.html, in a 64 box.
  const SPARK_D = 'M32 16 L36 28 L48 32 L36 36 L32 48 L28 36 L16 32 L28 28 Z';

  const GROUND = 330;

  /**
   * The two characters. Everything that differs between them is a number or a
   * flag here; nothing below this table knows which one it is drawing.
   *
   * Topic is the default node card (styles.css:1170, radius 12 on a card 34 to
   * 240 wide). Pip is the same card in the app's own "bubble" style
   * (styles.css:1435, radius 999), which is why it is a pill and not a
   * rounded-off rectangle: both silhouettes already exist in the product.
   */
  const SPECS = {
    topic: {
      name: 'Topic', cx: 200, cy: 200, w: 170, h: 130, rx: 30,
      eye: { r: 16, pupil: 8, gap: 38, dy: -12 },
      mouth: { dy: 30, half: 27, w: 9 },
      arm: { dy: -16, w: 14, hand: 16, restX: 132, restY: 258 },
      leg: { gap: 40, len: 42, w: 17, footW: 54, footH: 22 },
      antenna: { stem: 34, scale: 1.5 },
      tail: null
    },
    pip: {
      name: 'Pip', cx: 200, cy: 226, w: 126, h: 98, rx: 49,
      // Bigger eyes, closer together, higher in the face: the standard read for
      // "younger", and the only reason Pip is legible as Topic's child rather
      // than as Topic seen from further away.
      eye: { r: 17, pupil: 9, gap: 30, dy: -10 },
      mouth: { dy: 24, half: 20, w: 8 },
      arm: { dy: -8, w: 12, hand: 13, restX: 104, restY: 274 },
      leg: { gap: 26, len: 32, w: 15, footW: 44, footH: 20 },
      antenna: null,
      // Pip's tail IS the edge back to its parent. It is the one part of the
      // drawing that says "this is a child node" rather than "this is a smaller
      // mascot", so it gets to wag.
      tail: { dx: -78, dy: 48, dot: 9 }
    }
  };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function build(p, spec, C) {
    const id = n => p + '-' + n;
    const svg = el('svg', { viewBox: '0 0 400 400', role: 'img',
                            preserveAspectRatio: 'xMidYMid meet' });
    el('title', null, svg).textContent = spec.name + ' - a MindSpark mascot';

    const defs = el('defs', null, svg);
    // The ground clip, borrowed from Claude's mascot: a leg swung past the floor
    // is cut at the floor instead of hanging through it. Cheaper and steadier
    // than clamping every leg angle, and it also catches the squash frames.
    const clip = el('clipPath', { id: id('floor') }, defs);
    el('rect', { x: 0, y: 0, width: 400, height: GROUND + 3 }, clip);

    const root = el('g', null, svg);
    const shadow = el('ellipse', { cx: spec.cx, cy: GROUND + 4, rx: spec.w * 0.42,
                                   ry: 8, fill: C.shadow, opacity: 0.15 }, root);

    // bob -> squash -> everything. Two groups so a jump can move the body
    // without also scaling the shadow, and a squash always keeps the feet down.
    const bob = el('g', null, root);
    const squash = el('g', null, bob);

    // ---- legs, behind the card, clipped at the floor ----
    const legWrap = el('g', { 'clip-path': `url(#${id('floor')})` }, squash);
    const legs = [-1, 1].map(side => {
      const g = el('g', { transform: `translate(${spec.cx + side * spec.leg.gap} ${spec.cy + spec.h / 2 - 4})` }, legWrap);
      el('line', { x1: 0, y1: 0, x2: 0, y2: spec.leg.len, stroke: C.card,
                   'stroke-width': spec.leg.w, 'stroke-linecap': 'round' }, g);
      const foot = el('g', { transform: `translate(0 ${spec.leg.len})` }, g);
      el('rect', { x: -spec.leg.footW / 2, y: -spec.leg.footH / 2 + 4,
                   width: spec.leg.footW, height: spec.leg.footH,
                   rx: spec.leg.footH / 2, fill: C.card }, foot);
      return { g, foot, side };
    });

    // ---- the far arm, behind the card ----
    const armL = arm(squash, spec, C, -1);

    // ---- tail (Pip only): the branch edge back to its parent ----
    let tail = null;
    if (spec.tail) {
      const g = el('g', null, squash);
      const path = el('path', { fill: 'none', stroke: C.card,
                                'stroke-width': spec.arm.w * 0.72, 'stroke-linecap': 'round' }, g);
      const dot = el('circle', { r: spec.tail.dot, fill: C.card }, g);
      tail = { path, dot };
    }

    // ---- the card ----
    const card = el('g', null, squash);
    el('rect', { x: spec.cx - spec.w / 2, y: spec.cy - spec.h / 2,
                 width: spec.w, height: spec.h, rx: spec.rx, fill: C.card }, card);

    const eyeY = spec.cy + spec.eye.dy;
    const eyes = el('g', null, card);
    const eyeParts = [-1, 1].map(side => {
      // The open eye and the closed lid are SIBLINGS, not nested. Nested, the
      // lid faded out along with the eyeball it was supposed to replace and a
      // sleeping face came out as two smudges.
      const g = el('g', null, eyes);
      el('circle', { cx: spec.cx + side * spec.eye.gap, cy: eyeY, r: spec.eye.r, fill: C.face }, g);
      const pupil = el('circle', { cx: spec.cx + side * spec.eye.gap, cy: eyeY,
                                   r: spec.eye.pupil, fill: C.pupil }, g);
      // Closed lids are drawn, not scaled: a squashed circle still reads as an
      // eye, whereas an arc reads as a lid, which is what a sleeping face needs.
      const lid = el('path', {
        d: `M${spec.cx + side * spec.eye.gap - spec.eye.r} ${eyeY + 2} q${spec.eye.r} ${-spec.eye.r * 1.05} ${spec.eye.r * 2} 0`,
        fill: 'none', stroke: C.face, 'stroke-width': spec.mouth.w * 0.9,
        'stroke-linecap': 'round', opacity: 0
      }, eyes);
      return { g, pupil, lid, side };
    });

    const mouth = el('path', { fill: 'none', stroke: C.face,
                               'stroke-width': spec.mouth.w, 'stroke-linecap': 'round' }, card);

    // ---- the near arm, in front of the card: this is the one that waves ----
    const armR = arm(squash, spec, C, 1);

    // ---- antenna (Topic) and the idea spark (both) ----
    let stem = null;
    const sparkG = el('g', null, squash);
    if (spec.antenna) {
      stem = el('path', { fill: 'none', stroke: C.card, 'stroke-width': 10,
                          'stroke-linecap': 'round' }, sparkG);
    }
    const spark = el('path', { d: SPARK_D, fill: C.terra }, sparkG);
    if (!spec.antenna) spark.setAttribute('opacity', '0');

    // sparks thrown on an idea
    const burstG = el('g', { opacity: 0 }, root);
    const burst = [];
    for (let i = 0; i < 6; i++) {
      burst.push(el('path', { d: SPARK_D, fill: C.terra }, burstG));
    }

    // the node carried in 'drag', held overhead: anywhere lower and it covers
    // the face, which is the whole character
    const cargo = el('g', { opacity: 0 }, squash);
    el('rect', { x: -34, y: -24, width: 68, height: 48, rx: 14, fill: C.terra }, cargo);

    // the line the 'write' state writes. Without it the pose is a character
    // bending down, not a character working.
    const line = el('path', { fill: 'none', stroke: C.terra, 'stroke-width': 6,
                              'stroke-linecap': 'round', opacity: 0 }, root);

    // sleep z's, drawn as polylines so nothing here needs a font
    const zzz = el('g', { opacity: 0 }, root);
    const zs = [0, 1, 2].map(i => el('path', {
      fill: 'none', stroke: C.terra, 'stroke-width': 7 - i * 1.2, 'stroke-linejoin': 'round'
    }, zzz));

    return { svg, root, bob, squash, card, shadow, eyes: eyeParts, mouth,
             armL, armR, legs, tail, stem, spark, sparkG, burstG, burst, cargo, line, zzz, zs };
  }

  /** One arm: a branch edge from the shoulder to a hand that is a child node. */
  function arm(parent, spec, C, side) {
    const g = el('g', null, parent);
    const path = el('path', { fill: 'none', stroke: C.card, 'stroke-width': spec.arm.w,
                              'stroke-linecap': 'round' }, g);
    const hand = el('circle', { r: spec.arm.hand, fill: side > 0 ? C.terra : C.teal }, g);
    return { path, hand, side,
             sx: spec.cx + side * (spec.w / 2 - 6), sy: spec.cy + spec.arm.dy };
  }

  const STATES = ['idle', 'look', 'wave', 'walk', 'hop', 'idea', 'think',
                  'write', 'drag', 'cheer', 'sleep', 'wake', 'pop'];

  /**
   * The beat table. Clawd's loop is a fixed sequence of beats rather than a
   * reaction to anything on the page, and that is what makes it read as a
   * creature getting on with its day instead of a widget responding to you.
   * `t` is seconds; `look` aims the eyes for beats that have somewhere to look.
   */
  const SCRIPT = [
    { s: 'idle',  t: 2.2 },
    { s: 'look',  t: 1.3, look: [-1, -0.2] },
    { s: 'look',  t: 1.3, look: [1, 0.1] },
    { s: 'walk',  t: 2.6 },
    { s: 'think', t: 2.2 },
    { s: 'idea',  t: 1.6 },
    { s: 'cheer', t: 1.2 },
    { s: 'idle',  t: 1.6 },
    { s: 'write', t: 2.8 },
    { s: 'hop',   t: 1.0 },
    { s: 'wave',  t: 1.8 },
    { s: 'idle',  t: 1.4 },
    { s: 'sleep', t: 3.2 },
    { s: 'wake',  t: 1.2 }
  ];

  class CardMascot {
    constructor(container, opts) {
      opts = opts || {};
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('CardMascot: container not found');

      this.spec = SPECS[opts.character] || SPECS.topic;
      this.C = THEMES[opts.theme === 'dark' ? 'dark' : 'light'];
      this.h = build('cm' + (CardMascot._seq = (CardMascot._seq || 0) + 1), this.spec, this.C);
      this.svg = this.h.svg;
      this.svg.setAttribute('aria-label', this.spec.name + ', a MindSpark mascot');
      if (opts.width) this.svg.setAttribute('width', opts.width);
      this.container.appendChild(this.svg);

      this.t = 0;
      this.state = opts.state || 'idle';
      this.stateT = 0;
      this.phase = Math.random() * 6;      // desynchronises two mascots on one page
      this.blinkIn = rnd(1.4, 4);
      this.blinkT = -1;
      this.auto = !!opts.auto;
      this.beat = 0;
      this.beatT = 0;
      this.lookTo = { x: 0, y: 0 };
      this.burstT = -1;

      // Every animated quantity lives here and is EASED toward a target, which
      // is what lets one state hand over to another mid-pose.
      this.v = {
        bodyY: 0, lean: 0, squash: 0, lookX: 0, lookY: 0,
        lhx: 0, lhy: 0, rhx: 0, rhy: 0, lbend: 0, rbend: 0,
        lid: 0, mouth: 0, ant: 0, tail: 0, cargo: 0
      };
      const s = this.spec;
      this.v.lhx = s.cx - s.arm.restX; this.v.lhy = s.arm.restY;
      this.v.rhx = s.cx + s.arm.restX; this.v.rhy = s.arm.restY;

      this.walkPhase = 0;
      this.running = false;
      this._raf = 0;
      this._prev = 0;

      if (opts.follow) this._follow();
      this._render(0);
      if (opts.autoStart !== false) this.start();
    }

    // Cursor following is opt-in. A mascot that tracks the pointer everywhere
    // reads as a gadget; the scripted loop is the character.
    _follow() {
      this._onMove = e => {
        const r = this.svg.getBoundingClientRect();
        if (!r.width) return;
        this.look((e.clientX - (r.left + r.width / 2)) / (r.width * 0.7),
                  (e.clientY - (r.top + r.height * 0.45)) / (r.height * 0.6));
      };
      window.addEventListener('pointermove', this._onMove, { passive: true });
    }

    look(x, y) {
      this.lookTo.x = clamp(x, -1, 1);
      this.lookTo.y = clamp(y, -1, 1);
      return this;
    }

    setState(s) {
      if (STATES.indexOf(s) < 0) return this;
      this.state = s;
      this.stateT = 0;
      if (s === 'idea' || s === 'cheer') this.burstT = 0;
      if (s === 'pop') this.v.squash = -0.85;
      return this;
    }

    setAuto(on) {
      this.auto = !!on;
      if (this.auto) { this.beat = 0; this.beatT = 0; this._beat(); }
      return this;
    }

    _beat() {
      const b = SCRIPT[this.beat % SCRIPT.length];
      this.setState(b.s);
      if (b.look) this.look(b.look[0], b.look[1]);
      else if (b.s !== 'look') this.look(0, 0);
      // Jitter so the loop never plays the same bar twice running.
      this.beatT = b.t * rnd(0.85, 1.2);
      this.beat++;
    }

    start() {
      if (this.running) return this;
      this.running = true;
      this._prev = 0;
      if (this.auto && !this.beatT) this._beat();
      const loop = ts => {
        if (!this.running) return;
        const dt = this._prev ? Math.min((ts - this._prev) / 1000, 0.05) : 0;
        this._prev = ts;
        this.t += dt;
        this.stateT += dt;
        if (this.auto) {
          this.beatT -= dt;
          if (this.beatT <= 0) this._beat();
        }
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
      if (this._onMove) window.removeEventListener('pointermove', this._onMove);
      if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
      return this;
    }

    _render(dt) {
      const h = this.h, s = this.spec, v = this.v, C = this.C;
      const t = this.t + this.phase, st = this.state;
      const breathe = Math.sin(t * 1.7) * 1.2;

      // ---- targets for this state ----
      const restL = { x: s.cx - s.arm.restX, y: s.arm.restY };
      const restR = { x: s.cx + s.arm.restX, y: s.arm.restY };
      let T = {
        bodyY: breathe, lean: 0, squash: 0,
        lhx: restL.x, lhy: restL.y, rhx: restR.x, rhy: restR.y,
        lbend: 26, rbend: -26, lid: 0, mouth: 0, ant: 0, tail: 0, cargo: 0
      };
      let legL = 0, legR = 0, k = 9;

      if (st === 'walk') {
        this.walkPhase = (this.walkPhase + dt / 0.62) % 1;
        const a = Math.PI * 2 * this.walkPhase;
        legL = Math.sin(a) * 26;
        legR = Math.sin(a + Math.PI) * 26;
        T.bodyY = breathe - Math.abs(Math.sin(a * 2)) * 3.4;
        T.lean = 4;
        T.lhx = restL.x + 16 + Math.sin(a + Math.PI) * 22;
        T.rhx = restR.x - 16 + Math.sin(a) * 22;
        T.lhy = restL.y - 10; T.rhy = restR.y - 10;
        T.ant = 3; T.tail = 16; T.mouth = 0.3;
        k = 14;
      } else if (st === 'wave') {
        const w = Math.sin(t * 7.4);
        T.rhx = s.cx + s.w / 2 + 34 + w * 20;
        T.rhy = s.cy - s.h / 2 - 34 - Math.abs(w) * 8;
        T.rbend = -46;
        T.mouth = 1; T.ant = 6; T.lean = -2; T.tail = 10 + w * 8;
      } else if (st === 'idea') {
        const q = clamp(this.stateT / 0.26, 0, 1);
        T.bodyY = breathe - Math.sin(clamp(this.stateT / 0.5, 0, 1) * Math.PI) * 9;
        T.lhx = restL.x + 6; T.lhy = s.cy - s.h / 2 - 26 * q;
        T.rhx = restR.x - 6; T.rhy = s.cy - s.h / 2 - 26 * q;
        T.lbend = 44; T.rbend = -44;
        T.mouth = 1.4; T.ant = 16 * q; T.squash = 0.05 * q; T.tail = -14;
        k = 16;
      } else if (st === 'think') {
        // one hand up to the corner of the card, eyes up: the pose everything
        // from Rodin to a Pixar short uses, because it reads instantly
        T.rhx = s.cx + s.w / 2 - 8; T.rhy = s.cy - s.h / 2 + 6;
        T.rbend = -18;
        T.lookY = -1;
        T.ant = Math.sin(t * 1.6) * 5;
        T.lean = -2; T.mouth = -0.4; T.tail = Math.sin(t * 1.1) * 6;
      } else if (st === 'write') {
        // Hands OUTSIDE the silhouette and down at the line, or the arms
        // disappear behind the card and the pose reads as bending over.
        const a = ((this.stateT % 2.2) / 2.2);
        T.lhx = s.cx - s.w / 2 - 26; T.lhy = s.cy + s.h / 2 + 26;
        T.rhx = s.cx - 60 + a * 150; T.rhy = s.cy + s.h / 2 + 34 + Math.sin(a * 22) * 3;
        T.lbend = 20; T.rbend = -14;
        T.lookX = 0.4; T.lookY = 0.8; T.mouth = 0.2; T.ant = Math.sin(t * 4) * 4;
        k = 16;
      } else if (st === 'drag') {
        // carried overhead, like a mover with a box: the only place a held node
        // does not cover the face
        const sway = Math.sin(t * 2.6) * 4;
        T.lhx = s.cx - 54; T.lhy = s.cy - s.h / 2 - 16;
        T.rhx = s.cx + 54; T.rhy = s.cy - s.h / 2 - 16;
        T.lbend = 30; T.rbend = -30;
        T.cargo = 1; T.lean = sway * 0.4; T.mouth = 0.2; T.lookY = -0.3;
        // shove the antenna aside so the carried node does not swallow the mark
        T.ant = 26; T.squash = 0.05;
      } else if (st === 'hop') {
        // one arc, then it settles. Squash on the way down is the whole gag.
        const q = clamp(this.stateT / 0.62, 0, 1);
        const air = Math.sin(q * Math.PI);
        T.bodyY = breathe - air * 46;
        T.squash = q < 0.12 ? -0.16 : (q > 0.9 ? 0.14 : 0.06 * air);
        T.lhy = restL.y - air * 26; T.rhy = restR.y - air * 26;
        T.lhx = restL.x - air * 10; T.rhx = restR.x + air * 10;
        legL = -12 * air; legR = 12 * air;
        T.mouth = 1; T.ant = 12 * air; T.tail = -20 * air;
        k = 18;
      } else if (st === 'cheer') {
        const b = Math.abs(Math.sin(t * 5.2));
        T.bodyY = breathe - b * 16;
        T.lhx = restL.x + 18; T.lhy = s.cy - s.h / 2 - 30 - b * 10;
        T.rhx = restR.x - 18; T.rhy = s.cy - s.h / 2 - 30 - b * 10;
        T.lbend = 40; T.rbend = -40;
        T.mouth = 1.5; T.ant = 14; T.squash = b * 0.06; T.tail = -16;
        k = 15;
      } else if (st === 'sleep') {
        T.bodyY = breathe * 2.2;
        T.lid = 1; T.mouth = -0.2; T.ant = -20; T.lean = -3;
        T.lhy = restL.y + 6; T.rhy = restR.y + 6;
        T.tail = 6 + Math.sin(t * 0.8) * 6;
        k = 3.5;
      } else if (st === 'wake') {
        // a stretch: arms up and back, body long, then the ease drops it to idle
        const q = clamp(this.stateT / 0.9, 0, 1);
        const up = Math.sin(q * Math.PI);
        T.lhx = restL.x - 14; T.lhy = s.cy - s.h / 2 - 20 * up;
        T.rhx = restR.x + 14; T.rhy = s.cy - s.h / 2 - 20 * up;
        T.squash = -0.1 * up; T.bodyY = breathe - 6 * up;
        T.lid = 1 - q; T.mouth = 0.6 * up; T.ant = 8 * up;
      } else if (st === 'pop') {
        // spawn, with overshoot. This is the '+ Topic' beat: a node appearing.
        const q = clamp(this.stateT / 0.45, 0, 1);
        const o = 1 - Math.pow(1 - q, 3);
        T.squash = (1 - o) * -0.7 + Math.sin(q * Math.PI * 2) * 0.08;
        T.bodyY = breathe - Math.sin(q * Math.PI) * 10;
        T.mouth = 1.2; T.ant = 10 * o;
        k = 20;
      } else if (st === 'look') {
        T.lookX = this.lookTo.x; T.lookY = this.lookTo.y;
        T.lean = this.lookTo.x * 2.5;
        T.ant = -this.lookTo.x * 6;
        T.tail = Math.sin(t * 1.3) * 5;
      } else {
        // idle: a slow weight shift and a drifting antenna, so it is never still
        T.lean = Math.sin(t * 0.62) * 2.2;
        T.ant = Math.sin(t * 0.8 + 1) * 4;
        T.tail = Math.sin(t * 0.9) * 7;
        T.lhy = restL.y + Math.sin(t * 1.7) * 2;
        T.rhy = restR.y + Math.sin(t * 1.7 + 0.6) * 2;
      }

      // states that do not aim the eyes still follow whatever look() was given
      if (T.lookX === undefined || (st !== 'look' && st !== 'think' && st !== 'write' && st !== 'drag')) {
        T.lookX = this.lookTo.x;
        if (T.lookY === undefined) T.lookY = this.lookTo.y;
      }
      if (T.lookY === undefined) T.lookY = this.lookTo.y;

      // ---- ease everything toward the targets ----
      for (const key in v) {
        if (T[key] !== undefined) v[key] = ease(v[key], T[key], dt, key === 'squash' ? k * 1.4 : k);
      }

      // ---- draw ----
      const sq = clamp(v.squash, -0.9, 0.4);
      h.bob.setAttribute('transform', `translate(0 ${v.bodyY.toFixed(2)})`);
      // scale about the feet, never the centre: a character that squashes about
      // its middle sinks into the floor and lifts off it again
      h.squash.setAttribute('transform',
        `translate(${s.cx} ${GROUND}) scale(${(1 + sq).toFixed(4)} ${(1 - sq).toFixed(4)}) ` +
        `rotate(${v.lean.toFixed(2)}) translate(${-s.cx} ${-GROUND})`);

      // arms: quadratic from shoulder to hand, bent by the perpendicular
      [[h.armL, v.lhx, v.lhy, v.lbend], [h.armR, v.rhx, v.rhy, v.rbend]].forEach(([A, hx, hy, bend]) => {
        const mx = (A.sx + hx) / 2, my = (A.sy + hy) / 2;
        const dx = hx - A.sx, dy = hy - A.sy;
        const len = Math.hypot(dx, dy) || 1;
        A.path.setAttribute('d',
          `M${A.sx} ${A.sy} Q${(mx - dy / len * bend).toFixed(1)} ${(my + dx / len * bend).toFixed(1)} ${hx.toFixed(1)} ${hy.toFixed(1)}`);
        A.hand.setAttribute('cx', hx.toFixed(1));
        A.hand.setAttribute('cy', hy.toFixed(1));
      });

      h.legs.forEach((L, i) => {
        const a = i === 0 ? legL : legR;
        L.g.setAttribute('transform',
          `translate(${s.cx + L.side * s.leg.gap} ${s.cy + s.h / 2 - 4}) rotate(${a.toFixed(2)})`);
        // counter-rotate the foot so it stays flat on the floor
        L.foot.setAttribute('transform', `translate(0 ${s.leg.len}) rotate(${(-a).toFixed(2)})`);
      });

      // eyes: pupils travel inside the white, lids close over them
      const px = v.lookX * (s.eye.r - s.eye.pupil), py = v.lookY * (s.eye.r - s.eye.pupil) * 0.8;
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        if (this.blinkT > 0.15) { this.blinkT = -1; this.blinkIn = rnd(1.8, 5); }
      } else if (st !== 'sleep' && (this.blinkIn -= dt) <= 0) this.blinkT = 0;
      const blink = this.blinkT >= 0 ? Math.sin(Math.PI * (this.blinkT / 0.15)) : 0;
      const lid = clamp(Math.max(v.lid, blink), 0, 1);
      h.eyes.forEach(E => {
        E.pupil.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
        E.g.setAttribute('opacity', (1 - lid).toFixed(2));
        E.lid.setAttribute('opacity', lid.toFixed(2));
      });

      // mouth: one path, morphed. Negative is a flat line (thinking), positive
      // opens the smile, so a single number covers the whole range.
      const m = v.mouth, my0 = s.cy + s.mouth.dy;
      const curve = 10 + m * 14;
      h.mouth.setAttribute('d',
        `M${s.cx - s.mouth.half} ${my0} q${s.mouth.half} ${curve.toFixed(1)} ${s.mouth.half * 2} 0`);

      // antenna and spark
      const ant = v.ant;
      if (s.antenna) {
        const tipX = s.cx + ant * 0.9, tipY = s.cy - s.h / 2 - s.antenna.stem;
        h.stem.setAttribute('d', `M${s.cx} ${s.cy - s.h / 2 + 2} Q${s.cx + ant * 0.35} ${(tipY + 14).toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}`);
        const sc = s.antenna.scale * (1 + Math.max(0, ant) * 0.012);
        h.spark.setAttribute('transform',
          `translate(${tipX.toFixed(1)} ${(tipY - 16).toFixed(1)}) scale(${sc.toFixed(3)}) rotate(${(this.t * 22).toFixed(1)}) translate(-32 -32)`);
      } else {
        // Pip has no antenna, so its spark only exists while it has the idea
        const on = (st === 'idea' || st === 'cheer') ? clamp(this.stateT / 0.3, 0, 1) : 0;
        h.spark.setAttribute('opacity', on.toFixed(2));
        h.spark.setAttribute('transform',
          `translate(${s.cx} ${(s.cy - s.h / 2 - 34 - on * 8).toFixed(1)}) scale(${(1.25 * on).toFixed(3)}) rotate(${(this.t * 22).toFixed(1)}) translate(-32 -32)`);
      }

      // tail (Pip): the edge back to its parent, wagging
      if (h.tail) {
        // The tail leaves the BOTTOM of the pill and trails off near the
        // floor. Leaving from the side, it ran parallel to the arm and the two
        // read as one tangled limb.
        const tx = s.cx - s.w / 2 + 26, ty = s.cy + s.h / 2 - 8;
        const ex = tx + s.tail.dx, ey = ty + s.tail.dy + v.tail * 0.5;
        h.tail.path.setAttribute('d', `M${tx} ${ty} Q${(tx + s.tail.dx * 0.35).toFixed(1)} ${(ty + 40).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
        h.tail.dot.setAttribute('cx', ex.toFixed(1));
        h.tail.dot.setAttribute('cy', ey.toFixed(1));
      }

      // the node carried in 'drag', and the line written in 'write'
      h.cargo.setAttribute('opacity', v.cargo.toFixed(2));
      h.cargo.setAttribute('transform',
        `translate(${s.cx} ${(s.cy - s.h / 2 - 34).toFixed(1)}) rotate(${(v.lean * 1.5).toFixed(2)}) scale(${(0.6 + 0.4 * v.cargo).toFixed(3)})`);
      if (st === 'write') {
        const a = ((this.stateT % 2.2) / 2.2);
        const x0 = s.cx - 60, y0 = s.cy + s.h / 2 + 40;
        h.line.setAttribute('opacity', clamp(this.stateT / 0.3, 0, 1).toFixed(2));
        h.line.setAttribute('d', `M${x0} ${y0} L${(x0 + a * 150).toFixed(1)} ${y0}`);
      } else {
        h.line.setAttribute('opacity', '0');
      }

      // shadow shrinks as the body leaves the floor
      const lift = clamp(-v.bodyY / 30, 0, 1);
      h.shadow.setAttribute('rx', (s.w * 0.42 * (1 - lift * 0.3)).toFixed(1));
      h.shadow.setAttribute('opacity', (0.15 - lift * 0.07).toFixed(3));

      // sparks thrown on idea/cheer
      if (this.burstT >= 0) {
        this.burstT += dt;
        const q = this.burstT / 0.8;
        if (q >= 1) { this.burstT = -1; h.burstG.setAttribute('opacity', '0'); }
        else {
          h.burstG.setAttribute('opacity', (1 - q).toFixed(2));
          h.burst.forEach((sp, i) => {
            const a = (-Math.PI / 2) + (i - 2.5) * 0.38;
            const r = 20 + q * 66;
            sp.setAttribute('transform',
              `translate(${(s.cx + Math.cos(a) * r).toFixed(1)} ${(s.cy - s.h / 2 - 20 + Math.sin(a) * r * 0.7 + q * q * 30).toFixed(1)}) ` +
              `scale(${(0.5 * (1 - q)).toFixed(3)}) translate(-32 -32)`);
          });
        }
      }

      // z's, only while asleep
      const zOn = st === 'sleep' ? clamp((this.stateT - 0.3) / 0.6, 0, 1) : 0;
      h.zzz.setAttribute('opacity', zOn.toFixed(2));
      if (zOn > 0) {
        h.zs.forEach((z, i) => {
          const drift = (this.t * 0.5 + i * 0.33) % 1;
          const zx = s.cx + s.w / 2 - 6 + i * 22 + drift * 16;
          const zy = s.cy - s.h / 2 - 6 - i * 26 - drift * 26;
          const sz = 12 + i * 4;
          z.setAttribute('d', `M${zx} ${zy} h${sz} l${-sz} ${sz * 1.1} h${sz}`);
          z.setAttribute('opacity', (1 - drift).toFixed(2));
        });
      }
    }
  }

  CardMascot.STATES = STATES;
  CardMascot.SPECS = SPECS;
  CardMascot.THEMES = THEMES;
  CardMascot.SCRIPT = SCRIPT;
  global.CardMascot = CardMascot;
  if (typeof module !== 'undefined' && module.exports) module.exports = CardMascot;
})(typeof window !== 'undefined' ? window : this);
