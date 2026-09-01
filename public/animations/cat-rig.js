/**
 * cat-rig.js - shared rig for the GitHub Octocat cats (cat-walk.js / cat-groom.js).
 *
 * Source of truth: gist:christophermanning/4460135/octocat.svg
 * (viewBox -0.2 -1 379 334 - black cat #000, peach face #F4CBB2, white eyes,
 *  rust pupils/nose/mouth #AD5C51, 9 suckers #C3E4D8, droplet + puddle #9CDAF1,
 *  shadow legs #7DBBE6). Every colour, radius and whisker count here is 1:1.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CAT_D is a *single closed subpath*: the four legs and the tail curl are just
 * runs of curve segments along one continuous outline. So a limb cannot be
 * pulled out by subpath index, and any transform applied to the whole path
 * moves the head too. Earlier attempts worked around that by clipping a
 * rotating *copy of the entire silhouette* to a rectangle around each limb,
 * which caps motion at 1-2 degrees before neighbouring geometry rotates into
 * the window - that is why the walk ended up with no leg motion at all.
 *
 * Instead, each limb below is the exact run of segments from CAT_D that traces
 * it, re-emitted in absolute coordinates and closed with a chord back to its
 * start. At rest a limb is pixel-identical to the original outline. The base
 * silhouette gets a matching hole punched in it (via <mask>) so the movable
 * copy is the only one visible, and then the copy can be translated/rotated
 * freely.
 *
 * SEAM RULES (the reason for the trim/clip offsets)
 * ------------------------------------------------
 * A hole in the base layer is only safe where the redrawn limb is guaranteed
 * to cover it, so each hole is trimmed *inside* the limb and the limb is drawn
 * slightly *past* the hole:
 *
 *   legs - hole trimmed to y >= LEG_HOLE_Y (234), limb clipped to y >= LEG_CLIP_Y
 *          (231), hinge on y = LEG_CLIP_Y. The 3px band between them keeps the
 *          original body pixels, so the hip joint can never open a gap, and the
 *          limb's own upper shaft (plus SHAFT filler) rotates through that band.
 *   tail - hole trimmed to x <= TAIL_HOLE_X (136); the curl is drawn unclipped
 *          because everything around it is background, so only the root needs
 *          covering and the intact body past x=136 does that.
 *   ears - hole and copy are both half-planes on the far side of the ear's own
 *          base chord, the copy from the chord and the hole from EAR_BAND (3)
 *          past it. Same 3px band, tilted: see EARS for why a chord is enough
 *          to isolate one ear.
 *
 * The band shows the limb's *rest* geometry, so anything that moves the limb at
 * the seam line shows up as a step there - the band guarantees no gap, not a
 * smooth join. Three things follow, and all are enforced in the rig rather than
 * left to the animators:
 *
 *   1. THE HINGE MUST BE A FIXED POINT of every limb transform. Rotation about
 *      it already is. Vertical travel is *not* if you translate: a limb lifted
 *      by L brings material from L further down the leg up to the seam, so the
 *      rotation's lateral displacement there grows from 3*sin(ang) to
 *      (3+L)*sin(ang) - at full lift and tuck that is ~1.6, a plainly visible
 *      jog. So setLimb() raises a paw by scaling the limb along its own axis
 *      about the hinge instead, which leaves the seam untouched and reads as
 *      foreshortening. There is no x parameter for the same reason: sideways
 *      paw motion goes through swayDeg(), as a rotation.
 *   2. A JOINT DISC, centred on the hinge and inscribed in the limb's shaft,
 *      sits in the static wrapper under each limb. Being centred on the pivot
 *      and outside the moving group, it covers the same socket at every pose,
 *      so the outline rounds off instead of ending on the chord that closes the
 *      extracted subpath. Without it a limb swung far from rest - the grooming
 *      forepaw at 160-plus degrees - leaves that chord lying across the
 *      shoulder as a hard, nearly horizontal cut.
 *   3. BETTER THAN A FIXED POINT IS A FIXED LINE. A rotation pins one point, so
 *      it always displaces the seam somewhere - 3*sin(ang), small but never
 *      zero. A *shear along the seam*, on the other hand, pins the whole seam
 *      line: in a frame whose u axis lies on the seam, (u, v) -> (u + s*v, k*v)
 *      leaves every v=0 point exactly where it was, while still carrying the far
 *      end of the part sideways by s*v_tip and lengthening it by (k-1)*v_tip.
 *      That is what setEar() and setTail()'s whip use, and it is why an ear can
 *      flick 6 units at the tip while moving under 0.5 at the base - a rotation
 *      big enough to show at the tip would tear the notch between the ears.
 *      Prefer this wherever the part joins along a line rather than at a socket.
 *   4. A FREE LIMB STILL GETS THE HIP TRIM, JUST IN ITS OWN FRAME. Each limb
 *      subpath includes the shoulder wedge above its hinge, where the outline
 *      runs on to the next limb - 22 units of it on the outer right hand. The
 *      body-space window hides that, but a free limb has no window (it has to
 *      reach above the hip line), so the wedge rides along, and past ~90 degrees
 *      of swing it lands well away from the shoulder as a detached lump: on the
 *      waving cat, a fifth paw down beside the feet. So the free limb's <use>
 *      hangs inside a group *within* the moving group, carrying the same
 *      y >= LEG_CLIP_Y window; inheriting the pose, the window trims the arm
 *      flat at its own shoulder at every angle, and rule 2's disc rounds it off.
 *
 *   5. A LIMB THAT HAS TO GESTURE NEEDS TWO BONES. One rigid segment hinged at
 *      the shoulder can only sweep as a board, and the shape on its end is a
 *      foot - the paw hooks outward and down, right for standing in a puddle,
 *      but rotated ~140 degrees to wave it curls back over itself. So the free
 *      limb is split at L.elbow into upper arm and forearm, both the SAME limb
 *      <use> clipped to their side of the line and overlapped by ELBOW_LAP, with
 *      an elbow disc (rule 2 again, at the elbow) filling the wedge a bend
 *      opens.
 *
 *      The stretch goes on the BONES, never on a shared ancestor: scale(1,k)
 *      applied above a rotated forearm is a shear and turns it into a wedge, so
 *      `move` carries rotation only and each bone scales along its own
 *      (rest-vertical) axis.
 *
 *      There is no separate "hand" shape. A tentacle tapers to its own point,
 *      and the waving one is the same tip as the three planted ones - an
 *      earlier pass bolted a rounded mitt on the end, which only flattened that
 *      taper into a blob. See the tentacle note above pawTip().
 *
 *      The split is invisible at rest: with every sub-transform identity the two
 *      halves reassemble into the original limb exactly, so
 *      setReach() on a free limb still behaves exactly as it did (cat-groom.js
 *      relies on this).
 *
 * Whiskers and ears are where the clip-window trick is still correct: the three
 * hairs per side are the *only* geometry inside their boxes, and each ear is the
 * only geometry on the far side of its own base chord (verified by sampling the
 * outline - every point past either chord falls within that ear's u range), so a
 * moving copy of the silhouette clipped to the window shows nothing else.
 *
 * HEAD IS DELIBERATELY RIGID: the peach face is a separate path sitting inside
 * the black hood. Bobbing/scaling one without the other tears the seam at the
 * hairline, so the head only ever rides the whole-body transform. Uniform
 * translate/rotate of the *entire* cat is always safe; independent sub-group
 * scaling is not.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function rect(box, attrs) {
    return Object.assign({
      x: String(box.x0), y: String(box.y0),
      width: String(box.x1 - box.x0), height: String(box.y1 - box.y0)
    }, attrs || {});
  }

  // ---------------------------------------------------------------- geometry

  const CAT_D = 'm378.18 141.32l.28-1.389c-31.162-6.231-63.141-6.294-82.487-5.49 3.178-11.451 4.134-24.627 4.134-39.32 0-21.073-7.917-37.931-20.77-50.759 2.246-7.25 5.246-23.351-2.996-43.963 0 0-14.541-4.617-47.431 17.396-12.884-3.22-26.596-4.81-40.328-4.81-15.109 0-30.376 1.924-44.615 5.83-33.94-23.154-48.923-18.411-48.923-18.411-9.78 24.457-3.733 42.566-1.896 47.063-11.495 12.406-18.513 28.243-18.513 47.659 0 14.658 1.669 27.808 5.745 39.237-19.511-.71-50.323-.437-80.373 5.572l.276 1.389c30.231-6.046 61.237-6.256 80.629-5.522.898 2.366 1.899 4.661 3.021 6.879-19.177.618-51.922 3.062-83.303 11.915l.387 1.36c31.629-8.918 64.658-11.301 83.649-11.882 11.458 21.358 34.048 35.152 74.236 39.484-5.704 3.833-11.523 10.349-13.881 21.374-7.773 3.718-32.379 12.793-47.142-12.599 0 0-8.264-15.109-24.082-16.292 0 0-15.344-.235-1.059 9.562 0 0 10.267 4.838 17.351 23.019 0 0 9.241 31.01 53.835 21.061v32.032s-.943 11.33-11.33 15.105c0 0-6.137 4.249.475 6.606 0 0 28.792 2.361 28.792-21.238v-34.929s-1.142-13.852 5.663-18.667v57.371s-.47 13.688-7.551 18.881c0 0-4.723 8.494 5.663 6.137 0 0 19.824-2.832 20.769-25.961l.449-58.06h4.765l.453 58.06c.943 23.129 20.768 25.961 20.768 25.961 10.383 2.357 5.663-6.137 5.663-6.137-7.08-5.193-7.551-18.881-7.551-18.881v-56.876c6.801 5.296 5.663 18.171 5.663 18.171v34.929c0 23.6 28.793 21.238 28.793 21.238 6.606-2.357.474-6.606.474-6.606-10.386-3.775-11.33-15.105-11.33-15.105v-45.786c0-17.854-7.518-27.309-14.87-32.3 42.859-4.25 63.426-18.089 72.903-39.591 18.773.516 52.557 2.803 84.873 11.919l.384-1.36c-32.131-9.063-65.692-11.408-84.655-11.96.898-2.172 1.682-4.431 2.378-6.755 19.25-.80 51.38-.79 82.66 5.46z';

  // Tail curl - CAT_D segments 22..26, closed with a chord at the root (x~144).
  const TAIL_D = 'M145.021 204.932C137.248 208.65 112.642 217.725 97.879 192.333C97.879 192.333 89.615 177.224 73.797 176.041C73.797 176.041 58.453 175.806 72.738 185.603C72.738 185.603 83.005 190.441 90.089 208.622C90.089 208.622 99.33 239.632 143.924 229.683Z';

  // The four limbs, outer-left to outer-right. In this front-facing pose the
  // outer pair (0, 3) read as the cat's hands and the taller inner pair (1, 2)
  // as its feet - the inner two attach ~20px higher on the body (y 207 vs 227).
  //   d      exact segment run from CAT_D, closed with a chord across the top
  //   shaft  vertical span of the limb's straight shaft; a filler rect over
  //          this range gives the hinge headroom to rotate without a gap
  //   hinge  x of the shaft centre (the limb swings about {hinge, LEG_CLIP_Y})
  //   foot   paw centre, used to place puddle ripples on foot-plant
  const LIMBS = [
    { name: 'hand-l', d: 'M143.924 229.683L143.924 261.715C143.924 261.715 142.981 273.045 132.594 276.82C132.594 276.82 126.457 281.069 133.069 283.426C133.069 283.426 161.861 285.787 161.861 262.188L161.861 227.259Z', shaft: { x0: 143.924, x1: 161.861 }, hinge: 152.89, foot: { x: 147, y: 283 } },
    { name: 'foot-l', d: 'M161.861 227.259C161.861 227.259 160.719 213.407 167.524 208.592L167.524 265.963C167.524 265.963 167.054 279.651 159.973 284.844C159.973 284.844 155.25 293.338 165.636 290.981C165.636 290.981 185.46 288.149 186.405 265.02L186.854 206.96Z', shaft: { x0: 167.524, x1: 186.405 }, hinge: 177.06, foot: { x: 172, y: 290 } },
    { name: 'foot-r', d: 'M186.854 206.96L191.619 206.96L192.072 265.02C193.015 288.149 212.84 290.981 212.84 290.981C223.223 293.338 218.503 284.844 218.503 284.844C211.423 279.651 210.952 265.963 210.952 265.963L210.952 209.087Z', shaft: { x0: 192.072, x1: 210.952 }, hinge: 201.48, foot: { x: 205, y: 290 } },
    { name: 'hand-r', d: 'M210.952 209.087C217.753 214.383 216.615 227.258 216.615 227.258L216.615 262.187C216.615 285.787 245.408 283.425 245.408 283.425C252.014 281.068 245.882 276.819 245.882 276.819C235.496 273.044 234.552 261.714 234.552 261.714L234.552 215.928Z', shaft: { x0: 216.615, x1: 234.552 }, hinge: 225.58, foot: { x: 231, y: 283 } }
  ];

  const LEG_CLIP_Y = 231;   // limbs are drawn only below this line; also the hinge line
  const LEG_HOLE_Y = 234;   // holes start 3px lower, leaving a protected band at the hip
  const TAIL_HOLE_X = 136;  // tail hole stops here; intact body past it covers the root
  const HOLE_GROW = 1.2;    // mask holes are grown by half this, so a hole always
                            // outruns the limb replacing it (see mask notes below)
  const SHAFT_INSET = 0.6;  // shaft fillers pull in by this much per side, so their
                            // straight edges stay inside the limb's curved ones
  const EAR_BAND = 3;       // protected band along an ear's base chord, as at the hip
  const ELBOW_T = 0.5;      // elbow sits halfway down the limb, as a two-bone rig does
  const ELBOW_LAP = 2;      // upper arm and forearm overlap by this much at the joint,
                            // so the seam can never open a hairline when it bends

  // Elbow line for each limb, in the limb's own rest frame.
  LIMBS.forEach(L => { L.elbow = LEG_CLIP_Y + (L.foot.y - LEG_CLIP_Y) * ELBOW_T; });
  const EAR_PAD = 8;        // ear windows overrun the chord ends by this much

  /**
   * The two hood points, as base chord + tip. Each ear is isolated by the chord
   * across its own base - from the notch between the ears (`a` on the right ear,
   * `b` on the left) to where the outer edge bends (the other end).
   *
   * A chord is enough on its own: sampling CAT_D's outline at 6000 points and
   * taking local coordinates in each chord's frame, *every* point that falls on
   * the ear side lies within that ear's own u range (0..len, to 0.1) - no other
   * part of the cat, including the opposite ear, reaches across either chord. So
   * the window can be a plain half-plane rect in the chord's frame, and the ear
   * needs no cut-out subpath of its own.
   *
   *   out  which u direction points away from the head, so animators can ask for
   *        "lean outward" and get the mirrored sign for free
   * Derived below: deg/len of the chord, and depth = how far the tip stands off
   * it (the lever arm every setEar() amount is measured against).
   */
  const EARS = [
    { name: 'ear-l', a: { x: 93.15, y: 47.47 }, b: { x: 143.97, y: 18.81 }, tip: { x: 95.04, y: 0.40 }, out: -1 },
    { name: 'ear-r', a: { x: 228.91, y: 17.79 }, b: { x: 279.34, y: 44.36 }, tip: { x: 276.34, y: 0.40 }, out: 1 }
  ];
  EARS.forEach(E => {
    const dx = E.b.x - E.a.x, dy = E.b.y - E.a.y;
    const th = Math.atan2(dy, dx);
    E.deg = th * 180 / Math.PI;
    E.len = Math.hypot(dx, dy);
    const tx = E.tip.x - E.a.x, ty = E.tip.y - E.a.y;
    // the ear stands off the chord on the negative-v side; depth is that reach
    E.depth = -(-tx * Math.sin(th) + ty * Math.cos(th));
  });

  const TAIL_TIP = { x: 73.797, y: 176.041 };   // far end of the sickle, from TAIL_D

  const GEO = {
    puddle: { cx: 190.72, cy: 295.43, rx: 106.22, ry: 37.176 },
    rippleY: 295,
    tailHinge: { x: 143, y: 217.5 },   // root centre, from sampling the sickle's mid-line
    dropAt: { x: 69, y: 193 },
    mouth: { x: 188.5, y: 162 },
    eyeY: 126,
    // the 3 hairs per side are the only geometry inside these boxes
    whiskL: { box: { x0: -5, y0: 130, x1: 81, y1: 158 }, pivot: { x: 80, y: 141 } },
    whiskR: { box: { x0: 298, y0: 130, x1: 384, y1: 158 }, pivot: { x: 299, y: 141 } },
    ground: { x: 188, y: 300 },        // rock/roll pivot, centre of the puddle line
    limbs: LIMBS,
    ears: EARS,
    // the sickle's long axis, hinge -> far tip. setTail()'s whip shears across
    // this, so the tip travels and the root (under the intact body) does not.
    tailAxis: {
      deg: Math.atan2(TAIL_TIP.y - 217.5, TAIL_TIP.x - 143) * 180 / Math.PI,
      len: Math.hypot(TAIL_TIP.x - 143, TAIL_TIP.y - 217.5)
    }
  };

  const SUCKER_D = [
    'm80.641 179.82 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm89.041 184.54 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm94.234 190.68 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm98.954 197.76 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm104.142 204.37 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm111.232 210.03 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm121.142 213.81 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm131.012 213.81 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z',
    'm141.022 212.17 c0 1.174-1.376 2.122-3.07 2.122-1.693 0-3.07-.948-3.07-2.122 0-1.175 1.377-2.127 3.07-2.127 1.694 0 3.07.95 3.07 2.13z'
  ];

  const FACE_D = 'm258.19 94.132c9.231 8.363 14.631 18.462 14.631 29.343 0 50.804-37.872 52.181-84.585 52.181-46.721 0-84.589-7.035-84.589-52.181 0-10.809 5.324-20.845 14.441-29.174 15.208-13.881 40.946-6.531 70.147-6.531 29.07-.004 54.72-7.429 69.95 6.357z';
  const EYE_L_D = 'm160.1 126.06 c0 13.994-7.88 25.336-17.6 25.336-9.72 0-17.6-11.342-17.6-25.336 0-13.992 7.88-25.33 17.6-25.33 9.72.01 17.6 11.34 17.6 25.33z';
  const EYE_R_D = 'm254.43 126.06 c0 13.994-7.88 25.336-17.6 25.336-9.72 0-17.6-11.342-17.6-25.336 0-13.992 7.88-25.33 17.6-25.33 9.72.01 17.6 11.34 17.6 25.33z';
  const PUPIL_L_D = 'm154.46 126.38 c0 9.328-5.26 16.887-11.734 16.887s-11.733-7.559-11.733-16.887c0-9.331 5.255-16.894 11.733-16.894 6.47 0 11.73 7.56 11.73 16.89z';
  const PUPIL_R_D = 'm248.88 126.38 c0 9.328-5.26 16.887-11.734 16.887s-11.733-7.559-11.733-16.887c0-9.331 5.255-16.894 11.733-16.894 6.47 0 11.73 7.56 11.73 16.89z';
  const NOSE_D = 'M 188.5 148.56 a 4.401 4.401 0 1 0 0.0001 0';
  const MOUTH_D = 'm178.23 159.69c-.26-.738.128-1.545.861-1.805.737-.26 1.546.128 1.805.861 1.134 3.198 4.167 5.346 7.551 5.346s6.417-2.147 7.551-5.346c.26-.738 1.067-1.121 1.805-.861s1.121 1.067.862 1.805c-1.529 4.324-5.639 7.229-10.218 7.229s-8.68-2.89-10.21-7.22z';
  const DROP_D = 'm69.369 186.12l-3.066 10.683s-.8 3.861 2.84 4.546c3.8-.074 3.486-3.627 3.223-4.781z';
  const SHADOW_L_D = 'm161.85 331.22v-26.5c0-3.422-.619-6.284-1.653-8.701 6.853 5.322 7.316 18.695 7.316 18.695v17.004c6.166.481 12.534.773 19.053.861l-.172-16.92c-.944-23.13-20.769-25.961-20.769-25.961-7.245-1.645-7.137 1.991-6.409 4.34-7.108-12.122-26.158-10.556-26.158-10.556-6.611 2.357-.475 6.607-.475 6.607 10.387 3.775 11.33 15.105 11.33 15.105v23.622c5.72.98 11.71 1.79 17.94 2.4z';
  const SHADOW_R_D = 'm245.4 283.48s-19.053-1.566-26.16 10.559c.728-2.35.839-5.989-6.408-4.343 0 0-19.824 2.832-20.768 25.961l-.174 16.946c6.509-.025 12.876-.254 19.054-.671v-17.219s.465-13.373 7.316-18.695c-1.034 2.417-1.653 5.278-1.653 8.701v26.775c6.214-.544 12.211-1.279 17.937-2.188v-24.113s.944-11.33 11.33-15.105c0-.01 6.13-4.26-.48-6.62z';

  /**
   * PLUMBER THEME - every value below is measured off public/plumber-octo.jpg
   * (896x896) rather than eyeballed. The JPEG was mapped into this viewBox by
   * two anchors: the whiskers span the full image width (svg x 0.007..378.46)
   * and the artwork's full height is svg y 0..332.6, giving x = px/2.368 and
   * y = (px - 50)/2.38. Colours are sampled pixels; geometry is the per-column
   * top/bottom of each colour's mask.
   */
  const PLUMBER = {
    red:     '#E30203',   // shirt, sleeves, hat, tail        (sampled #e40001)
    redDk:   '#A51A16',   // hat brim seam, tail suckers
    blue:    '#0A42AF',   // overalls                          (sampled #0743b8)
    blueDk:  '#062F80',
    iris:    '#1F93DF',   // eye ring                          (sampled #2791d6)
    pupil:   '#050505',   // eye centre                        (sampled #000001)
    nose:    '#CF7265',   // (sampled #dc7669)
    stache:  '#151515',
    brown:   '#8A4F35',   // shoes                             (sampled #925237)
    brownDk: '#5D3423',
    green:   '#01A03C',   // mushroom cap                      (sampled #00a13f)
    greenDk: '#2A553A',
    spot:    '#A8C5AD',
    yellow:  '#FDD835',
    white:   '#FFFFFF'
  };

  // The body below this line is the red shirt; the hood above it stays black.
  // The reference's red starts at y 185.7, and the silhouette has already
  // narrowed from hood width (x 111..269 at y 170) to shoulder width
  // (x 149..235 at y 182) by here, so a straight cut lands on the jaw line and
  // reads as the hood's own edge instead of a band ruled across the chest.
  const COLLAR_Y = 184;

  // Hat, traced from the reference's red mask column by column. The crown is one
  // elliptical arc (rx 125, ry 110.3) tip to tip whose apex lands at y 0.8 -
  // the same height as the ears' own tips, which is exactly what leaves both
  // ears standing clear either side of it. The brim is a cubic sagging to
  // y 100.8 at the outer lobes and rising to y 61.2 at centre.
  const HAT_D = 'M68.4 86.5 A125 110.3 0 0 1 312.1 86.5 ' +
                'C311.5 95 309 101 305.5 100.8 ' +
                'C262 48 116 48 72.5 100.8 ' +
                'C69 101 68.4 95 68.4 86.5 Z';
  const HAT_SEAM_D = 'M74 70 Q189 18.4 306 70';   // crown/brim divide

  // Mustache: outer tips at x 163.9 / 214.5 sitting high (y ~147), the body
  // sagging to y 162.5 under the nose. Drawn UNDER the nose, as in the
  // reference, so the nose overlaps it.
  const STACHE_D = 'M163.9 147.5 Q176 141.5 189.2 149.5 Q202.4 141.5 214.5 147.5 ' +
                   'Q212 156.5 202 156 Q199 163.5 189.2 163.5 ' +
                   'Q179.4 163.5 176.4 156 Q166 156.5 163.9 147.5 Z';

  // ------------------------------------------------------------------ styles

  function ensureStyle() {
    if (document.getElementById('cat-rig-style')) return;
    const s = document.createElement('style');
    s.id = 'cat-rig-style';
    s.textContent = `
      .cw-stage{position:relative;overflow:hidden;background:#ffffff;
        border:1px solid #d0d7de;border-radius:14px;min-height:360px}
      .cw-actor{position:absolute;bottom:14px;left:0;will-change:left;
        transform-origin:center bottom}
      .cw-label{position:absolute;left:14px;bottom:9px;font:600 10.5px/1 system-ui;
        letter-spacing:.35px;color:#8c959f;pointer-events:none;user-select:none}
    `;
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------------- build

  /**
   * Build the rigged Octocat.
   * @param {string} p  id prefix, so two cats can coexist on one page without
   *                    their <defs> ids (masks/clips) colliding.
   * @param {object} o  { freeHandIndex } - that limb is drawn unclipped and
   *                    above the face, so it can be lifted to the muzzle for
   *                    grooming. Omit for the walker, where every limb stays
   *                    clipped below the hip line.
   * @returns handles for the animator
   */
  function build(p, o) {
    o = o || {};
    const freeHand = typeof o.freeHandIndex === 'number' ? o.freeHandIndex : -1;
    const isPlumber = o.theme === 'plumber';
    const P = PLUMBER;
    // hands (0,3) are red sleeves, feet (1,2) blue overall legs
    const limbFill = i => isPlumber ? (i === 0 || i === 3 ? P.red : P.blue) : '#000';
    const id = n => p + '-' + n;
    const url = n => 'url(#' + id(n) + ')';

    const svg = el('svg', {
      width: '300', height: '265', viewBox: '-0.2 -1 379 334',
      role: 'img', preserveAspectRatio: 'xMidYMid meet'
    });
    const defs = el('defs', null, svg);

    // one authoritative copy of each shape; everything else is a <use>
    el('path', { id: id('cat'), d: CAT_D }, defs);
    el('path', { id: id('tail'), d: TAIL_D }, defs);
    LIMBS.forEach((L, i) => el('path', { id: id('limb' + i), d: L.d }, defs));

    // static clip windows (see SEAM RULES in the file header)
    el('clipPath', { id: id('legclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
      .appendChild(el('rect', { x: '-40', y: String(LEG_CLIP_Y), width: '460', height: '220' }));
    el('clipPath', { id: id('legholeclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
      .appendChild(el('rect', { x: '-40', y: String(LEG_HOLE_Y), width: '460', height: '220' }));
    el('clipPath', { id: id('shirtclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
      .appendChild(el('rect', { x: '-40', y: String(COLLAR_Y), width: '460', height: '420' }));
    el('clipPath', { id: id('hatclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
      .appendChild(el('path', { d: HAT_D }));
    el('clipPath', { id: id('tailholeclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
      .appendChild(el('rect', { x: '-40', y: '-40', width: String(TAIL_HOLE_X + 40), height: '420' }));
    [['whiskLclip', GEO.whiskL], ['whiskRclip', GEO.whiskR]].forEach(([n, r]) => {
      el('clipPath', { id: id(n), clipPathUnits: 'userSpaceOnUse' }, defs)
        .appendChild(el('rect', rect(r.box)));
    });

    // Ear windows. Both the moving copy and the mask hole are half-planes on the
    // ear side of its base chord, expressed in the chord's own frame - so they
    // are plain rects carrying the chord's rotation. The copy starts at the
    // chord (v <= 0), the hole EAR_BAND past it, leaving the tilted equivalent
    // of the hip's protected band.
    const earFrame = E => `translate(${E.a.x} ${E.a.y}) rotate(${E.deg.toFixed(4)})`;
    const earWin = (E, v0) => ({
      transform: earFrame(E), x: String(-EAR_PAD), y: '-400',
      width: String(E.len + 2 * EAR_PAD), height: String(400 - v0)
    });
    EARS.forEach((E, i) => {
      el('clipPath', { id: id('earclip' + i), clipPathUnits: 'userSpaceOnUse' }, defs)
        .appendChild(el('rect', earWin(E, 0)));
    });

    // Hole punched in the base silhouette wherever a movable copy takes over.
    // The holes are DILATED by HOLE_GROW (a black stroke straddling the edge)
    // so a hole is always a shade larger than the limb that replaces it. That
    // matters for anti-aliasing: if the two edges coincided exactly, the
    // half-covered boundary pixel would be painted twice and the outline would
    // render darker than the reference. Growing the hole instead lets the
    // redrawn limb's own edge define the silhouette. It costs nothing, because
    // every limb edge that is not protected by a clip faces background.
    const mask = el('mask', { id: id('mask'), maskUnits: 'userSpaceOnUse', x: '-40', y: '-40', width: '460', height: '420' }, defs);
    el('rect', { x: '-40', y: '-40', width: '460', height: '420', fill: '#fff' }, mask);
    el('g', { 'clip-path': url('tailholeclip') }, mask)
      .appendChild(el('use', { href: '#' + id('tail'), fill: '#000', stroke: '#000', 'stroke-width': String(HOLE_GROW) }));
    const legHoles = el('g', { 'clip-path': url('legholeclip') }, mask);
    LIMBS.forEach((L, i) => el('use', { href: '#' + id('limb' + i), fill: '#000', stroke: '#000', 'stroke-width': String(HOLE_GROW) }, legHoles));
    el('rect', rect(GEO.whiskL.box, { fill: '#000' }), mask);
    el('rect', rect(GEO.whiskR.box, { fill: '#000' }), mask);
    // Ears: like the whisker boxes, a solid black window is enough - nothing but
    // the one ear lives past its chord, so there is no need to clip the hole to
    // the silhouette or to dilate it against a coincident edge.
    EARS.forEach(E => el('rect', Object.assign(earWin(E, EAR_BAND), { fill: '#000' }), mask));

    if (freeHand >= 0) {
      const L = LIMBS[freeHand];
      el('clipPath', { id: id('upclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
        .appendChild(el('rect', { x: '-40', y: String(LEG_CLIP_Y), width: '460', height: String(L.elbow - LEG_CLIP_Y + ELBOW_LAP) }));
      el('clipPath', { id: id('foreclip'), clipPathUnits: 'userSpaceOnUse' }, defs)
        .appendChild(el('rect', { x: '-40', y: String(L.elbow - ELBOW_LAP), width: '460', height: '260' }));
    }

    /**
     * Plumber gloves, boots and tail glove.
     *
     * THESE ARE TENTACLES. Each limb is a tube of near-constant width that
     * curls outward and only narrows in its last few units - measuring the
     * true filled span per row (crossings of the closed subpath, not the
     * outline's min/max) gives 17.9 at the ankle, 18-23 through the curl, then
     * 15.4 and 8.1 at the very tip. The tail is the same: 8.8 wide 6 units back
     * from its point, 15.8 at 24 back, along an axis of about 207 degrees.
     *
     * An earlier pass took the outline's min/max per row instead, read that as
     * a "broad flat foot" 31 wide, and fitted a covering blob to it. That
     * envelope is the span of the CURL, not of the tentacle, which is why the
     * result came out as a slab: it was covering the empty air the curl encloses.
     *
     * So a glove is not a shape fitted over the tip - it IS the tip. Each is the
     * limb's own <use> recoloured and clipped to a half-plane cut across the
     * tube, perpendicular to the tentacle's local axis. That tapers exactly as
     * the tentacle tapers, cannot leave the colour underneath showing, and needs
     * no authored outline at all. The cut edge reads as the cuff; gloves get a
     * second copy 3.6 further along so a band of it stays visible.
     *
     * Cut points, in outward coordinates u = (x - hinge) * side, w = y - foot.y:
     * hands at (3.0, -11) with the tube running 28.8 degrees off vertical there,
     * feet at (2.8, -13) at 22.6 degrees.
     */
    const TIP_CUT = { hand: { u: 3.0, w: -11, deg: 28.8 }, foot: { u: 2.8, w: -13, deg: 22.6 } };

    function tipClips(L, i) {
      const s = i < 2 ? -1 : 1;
      const c = (i === 0 || i === 3) ? TIP_CUT.hand : TIP_CUT.foot;
      const frame = `translate(${(L.hinge + c.u * s).toFixed(2)} ${(L.foot.y + c.w).toFixed(2)}) ` +
                    `rotate(${(-c.deg * s).toFixed(2)})`;
      [[0, 'tipcut'], [3.0, 'tipcuff']].forEach(([off, n]) => {
        el('clipPath', { id: id(n + i), clipPathUnits: 'userSpaceOnUse' }, defs)
          .appendChild(el('rect', { transform: frame, x: '-70', y: String(off), width: '140', height: '95' }));
      });
    }

    function pawTip(L, i, parent) {
      const hand = i === 0 || i === 3, s = i < 2 ? -1 : 1;
      const g = el('g', null, parent);
      const cut = n => el('g', { 'clip-path': url(n + i) }, g);
      if (hand) {
        el('use', { href: '#' + id('limb' + i), fill: '#E6E6E6' }, cut('tipcut'));
        el('use', { href: '#' + id('limb' + i), fill: P.white,
          stroke: '#CFCFCF', 'stroke-width': '0.9' }, cut('tipcuff'));
      } else {
        const boot = cut('tipcut');
        el('use', { href: '#' + id('limb' + i), fill: P.brown,
          stroke: P.brownDk, 'stroke-width': '1' }, boot);
        // the lighter oval the reference carries on the toe, kept inside the boot
        el('ellipse', { cx: (L.hinge + 8 * s).toFixed(2), cy: (L.foot.y - 5).toFixed(2),
          rx: '4.6', ry: '3.1', fill: '#A8663F', opacity: '0.85' }, boot);
      }
      return g;
    }

    const root = el('g', { id: id('root') }, svg);

    // ---- water / platform: stays on the ground, never rides the body bob ----
    const puddle = el('g', { id: id('puddle') }, root);
    if (isPlumber) {
      // Mushroom platform (green with light spots) instead of blue puddle
      // The reference's cap occupies x 82.8..295.6, y 255.5..331.1 - within a
      // unit or two of GEO.puddle already, so only the colour was wrong: the
      // green sampled #00a13f, not the dark #2e7d32 this used.
      el('ellipse', { cx: String(GEO.puddle.cx), cy: String(GEO.puddle.cy + 4.5), rx: String(GEO.puddle.rx), ry: String(GEO.puddle.ry), fill: P.greenDk }, puddle);
      el('ellipse', { cx: String(GEO.puddle.cx), cy: String(GEO.puddle.cy), rx: String(GEO.puddle.rx * 0.995), ry: String(GEO.puddle.ry * 0.97), fill: P.green }, puddle);
      [[126, 286, 20, 12.5], [242, 283, 21, 13.5], [166, 312, 17, 10],
       [206, 307, 12, 9], [277, 302, 13, 9.5], [97, 303, 11, 8]].forEach(([cx, cy, rx, ry]) => {
        el('ellipse', { cx: String(cx), cy: String(cy), rx: String(rx), ry: String(ry), fill: P.spot }, puddle);
      });
      // the stem showing under the front lip of the cap
      el('rect', { x: '181', y: '299', width: '7', height: '17', rx: '3.5', fill: P.greenDk, opacity: '0.55' }, puddle);
      el('rect', { x: '191', y: '299', width: '7', height: '17', rx: '3.5', fill: P.greenDk, opacity: '0.55' }, puddle);
    } else {
      el('ellipse', { cx: String(GEO.puddle.cx), cy: String(GEO.puddle.cy), rx: String(GEO.puddle.rx), ry: String(GEO.puddle.ry), fill: '#9CDAF1' }, puddle);
    }
    const ripples = [];
    for (let i = 0; i < 8; i++) {
      // plumber has no water ripples (mushroom)
      const col = isPlumber ? P.spot : '#7ec3ea';
      ripples.push({ life: -1, e: el('ellipse', { cx: '0', cy: '0', rx: '0', ry: '0', fill: 'none', stroke: col, 'stroke-width': '1.6', opacity: '0', display: 'none' }, puddle) });
    }
    const shadow = el('g', { id: id('shadow') }, puddle);
    if (!isPlumber) {
      el('path', { fill: '#7DBBE6', d: SHADOW_L_D }, shadow);
      el('path', { fill: '#7DBBE6', d: SHADOW_R_D }, shadow);
    }

    // ---- the cat: one group so bob/rock is a single uniform transform ----
    const bob = el('g', { id: id('bob') }, root);

    if (isPlumber) LIMBS.forEach((L, i) => tipClips(L, i));

    // Limbs. All black, so z-order among them is free. Each is a static
    // wrapper (holding the clip, so the window does not travel with the limb)
    // around a moving inner group.
    const limbWraps = [];
    const fillerWraps = [];
    let armG = null;
    const limbGs = LIMBS.map((L, i) => {
      const free = i === freeHand;
      // Clipped limbs: one wrapper with the body-space window, holding the joint
      // disc, the filler rect, and the moving group.
      // Free limbs: the joint disc and filler go in a SEPARATE clipped wrapper
      // (so they're hidden at rest and the filler stays put while the arm swings),
      // and the moving limb itself goes in an UNCLIPPED wrapper (so it can reach
      // above the hip line). Both wrappers sit in `bob` as siblings.
      const wrap = el('g', free ? null : { 'clip-path': url('legclip') }, bob);
      // For free limbs we need a tiny static socket cap (half-circle) where the
      // arm vacated - not the tall rect that read as an extra limb. The cap is
      // a disc clipped to y>=231 so only the lower half shows, rounding the
      // body's socket without creating a stump.
      const fillerWrap = free ? el('g', { 'clip-path': url('legclip') }, bob) : null;

      // Joint disc: in the static wrapper, so it stays at the shoulder and
      // rounds off the socket. For free limbs the disc lives in the fillerWrap
      // (clipped to y>=231 so only the lower half shows) to round the body's
      // socket without creating a tall stump; the moving arm gets its own cap below.
      if (!free) {
        el('circle', {
          cx: String(L.hinge), cy: String(LEG_CLIP_Y),
          r: (L.shaft.x1 - L.shaft.x0) / 2, fill: limbFill(i)
        }, wrap);
      } else {
        el('circle', {
          cx: String(L.hinge), cy: String(LEG_CLIP_Y),
          r: (L.shaft.x1 - L.shaft.x0) / 2, fill: limbFill(i)
        }, fillerWrap);
      }
      const move = el('g', { id: id('limb' + i + '-move') }, wrap);
      // Every limb subpath carries a wedge of shoulder ABOVE its own hinge - for
      // the outer right hand that is 22 units of it, the curve up to where the
      // next limb starts. A clipped limb never shows it, so it is harmless
      // there. A free limb has no window, and once the arm swings the wedge is
      // no longer tucked under the chest: rotate the right hand up to wave and
      // it lands as a detached triangle down beside the feet - a fifth paw.
      // Trimming it in the limb's OWN frame (a group inside `move`, so the
      // window inherits the pose) cuts the arm off flat at its shoulder however
      // far it swings, and the joint disc above rounds that cut into a socket.
      const draw = free ? el('g', { 'clip-path': url('legclip') }, move) : move;
      // Plumber colours: hands = Mario red sleeve + white glove, feet = blue overalls + brown shoe
      // A FREE LIMB IS A TWO-BONE ARM. A single rigid segment cannot wave: it
      // reads as a bar hinged at the shoulder, and the paw - drawn to hang down
      // into a puddle - points the wrong way once it swings out, so it lands as
      // a blunt hook. Standard 2D cut-out practice is upper arm + forearm with
      // the forearm parented to the upper arm, and artwork overlapped at the
      // joint so no gap shows when it bends. Both halves are the SAME limb
      // <use>, each clipped to its side of L.elbow; because the clip window
      // sits inside the same transformed group as the art, the window travels
      // with the pose and keeps selecting the same run of the outline.
      //
      // The stretch has to go on the bones, not on the parent: a scale(1,k) on
      // an ancestor of a rotated forearm is a shear, and turns it into a wedge.
      // So `move` carries rotation only, and each bone scales along its own
      // (vertical, in rest space) axis. See setArm().
      let upperG = null, foreG = null, elbowG = null;
      if (free) {
        upperG = el('g', { id: id('limb' + i + '-upper') }, draw);
        el('use', { href: '#' + id('limb' + i), fill: limbFill(i) },
          el('g', { 'clip-path': url('upclip') }, upperG));
        // Elbow disc: centred on the pivot and inscribed in the shaft, it is the
        // exact region the joint sweeps, so it fills the wedge a bend opens at
        // any angle - seam rule 2, applied at the elbow instead of the hip. It
        // takes only the elbow's translation, never its scale, so it stays round.
        elbowG = el('g', { id: id('limb' + i + '-elbow') }, draw);
        el('circle', { cx: String(L.hinge), cy: String(L.elbow),
          r: (L.shaft.x1 - L.shaft.x0) / 2, fill: limbFill(i) }, elbowG);
        foreG = el('g', { id: id('limb' + i + '-fore') }, draw);
        el('use', { href: '#' + id('limb' + i), fill: limbFill(i) },
          el('g', { 'clip-path': url('foreclip') }, foreG));
      } else {
        el('use', { href: '#' + id('limb' + i), fill: limbFill(i) }, draw);
      }

      // Glove / shoe tips for plumber (small ellipses at the paw, on top of the limb)
      if (isPlumber) pawTip(L, i, free ? foreG : draw);
      // Free limbs need their own shoulder rounded too - the moving arm's flat
      // cut (y=231 in its own frame) is capped with a half-circle that travels
      // with the arm. Because the cap lives inside `draw` it inherits the same
      // clip (y>=231) and the same rotate/scale, so it always sits exactly on
      // the flat edge, turning the hard chord into a smooth half-circle joint.
      if (free) {
        el('circle', {
          cx: String(L.hinge), cy: String(LEG_CLIP_Y),
          r: (L.shaft.x1 - L.shaft.x0) / 2, fill: limbFill(i)
        }, upperG || draw);
      }
      // Filler over the shaft gives the hinge headroom: the clip hides it at
      // rest, so it only ever shows up filling the wedge a rotation opens at
      // the hip. Inset per side so its straight edges never poke past the
      // limb's curved ones. A clipped limb's filler goes in `move` so it swings
      // with the limb and stays hidden under the clip at rest. A free limb's
      // filler goes in the separate clipped wrapper (fillerWrap) at the limb's
      // rest position, starting at the clip line (not above it), so it's hidden
      // at rest but plugs the vacated socket when the arm swings away.
      if (!free) {
        el('rect', {
          x: String(L.shaft.x0 + SHAFT_INSET), y: '196',
          width: String(L.shaft.x1 - L.shaft.x0 - 2 * SHAFT_INSET), height: '48',
          fill: limbFill(i)   // must match the limb, or a themed sleeve shows a black band
        }, move);
      }
      limbWraps.push(wrap);
      fillerWraps.push(fillerWrap);
      if (free) armG = { limb: L, move, upper: upperG, fore: foreG, elbow: elbowG };
      return move;
    });

    const torso = el('g', { id: id('torso') }, bob);
    el('use', { href: '#' + id('cat'), fill: '#000', mask: url('mask') }, torso);
    // Plumber: repaint the silhouette below the collar red, so the hood stays
    // black and the body becomes a shirt. Same mask, so the limb/tail holes
    // still line up; the whiskers and ears sit above COLLAR_Y and are untouched.
    if (isPlumber) {
      el('g', { 'clip-path': url('shirtclip') }, torso)
        .appendChild(el('use', { href: '#' + id('cat'), fill: P.red, mask: url('mask') }));
    }

    // Parts that move as a clipped copy of the whole silhouette rather than as an
    // extracted subpath: the clip goes on a static outer group so the window
    // stays put in body space, and the inner group is what the animator poses.
    function spinPart(clipName, gid) {
      const spin = el('g', { id: id(gid) }, el('g', { 'clip-path': url(clipName) }, torso));
      el('use', { href: '#' + id('cat'), fill: '#000' }, spin);
      return spin;
    }
    const whiskL = spinPart('whiskLclip', 'whiskL');
    const whiskR = spinPart('whiskRclip', 'whiskR');
    const earGs = EARS.map((E, i) => spinPart('earclip' + i, 'ear' + i));

    // tail curl + the decorations that ride on it, in reference draw order
    const tailG = el('g', { id: id('tail-move') }, bob);
    el('use', { href: '#' + id('tail'), fill: isPlumber ? P.red : '#000' }, tailG);
    // plumber white glove tip on the tail (acts as an extra hand)
    if (isPlumber) {
    }

    const suckerG = el('g', { id: id('suckers') }, bob);
    // The reference keeps the tentacle's suckers, in a darker red against the
    // red arm - 617 px of #A51A16 along the tail. They were dropped here before.
    SUCKER_D.forEach(d => el('path', { fill: isPlumber ? P.redDk : '#C3E4D8', d }, suckerG));
    // Tail glove. Same rule as the limbs - the tail's own tip, recoloured and
    // cut across. The tail's extreme point is (66.65, 178.99), NOT TAIL_TIP
    // (73.8, 176.0), which is just a point on the outline; the sickle runs into
    // it at about 207 degrees and tapers from 15.8 wide 24 units back to 8.8 at
    // 6 back. The old ellipse was 26 across and horizontal - a saucer on a
    // tentacle. The cut sits 28 back from the point, matching the reference's
    // glove (svg x 65.9..92.7, y 178.3..196.7).
    //
    // It lives in its own group AFTER the suckers, not inside tailG: the suckers
    // are drawn over the tail, so a glove inside tailG had a sucker showing
    // through it. setTail() carries this group with the same transform.
    let tailTipG = null;
    if (isPlumber) {
      const tf = 'translate(91.60 191.70) rotate(117)';
      [[0, 'tailcut'], [3.0, 'tailcuff']].forEach(([off, n]) => {
        el('clipPath', { id: id(n), clipPathUnits: 'userSpaceOnUse' }, defs)
          .appendChild(el('rect', { transform: tf, x: '-40', y: String(off), width: '80', height: '46' }));
      });
      tailTipG = el('g', { id: id('tailtip') }, bob);
      el('use', { href: '#' + id('tail'), fill: '#E6E6E6' },
        el('g', { 'clip-path': url('tailcut') }, tailTipG));
      el('use', { href: '#' + id('tail'), fill: P.white, stroke: '#CFCFCF', 'stroke-width': '0.9' },
        el('g', { 'clip-path': url('tailcuff') }, tailTipG));
    }

    const dropG = el('g', { id: id('drop') }, bob);
    if (!isPlumber) el('path', { fill: '#9CDAF1', d: DROP_D }, dropG);

    // ---- face ----
    const faceG = el('g', { id: id('face') }, bob);
    el('path', { fill: '#F4CBB2', d: FACE_D }, faceG);
    const eyeL = el('path', { id: id('eyeL'), fill: '#FFF', d: EYE_L_D }, faceG);
    const eyeR = el('path', { id: id('eyeR'), fill: '#FFF', d: EYE_R_D }, faceG);
    const plumberEyeFill = isPlumber ? P.iris : '#AD5C51';
    const pupilL = el('path', { id: id('pupilL'), fill: plumberEyeFill, d: PUPIL_L_D }, faceG);
    const pupilR = el('path', { id: id('pupilR'), fill: plumberEyeFill, d: PUPIL_R_D }, faceG);
    // Reference eye, scanned across y 126: sclera 125..160.5, blue ring
    // 131.8..155.4, then a near-black centre 135.1..152 - i.e. a dark pupil
    // inside the blue, at 0.72 of the iris. Without it the eye reads as a flat
    // blue disc, which was the single most wrong thing about the face.
    if (isPlumber) {
      [[142.73, 126.38], [237.15, 126.38]].forEach(([cx, cy]) => {
        el('ellipse', { cx: String(cx), cy: String(cy), rx: '8.5', ry: '12.2', fill: P.pupil }, faceG);
        el('circle', { cx: String(cx - 3.4), cy: String(cy - 5.4), r: '2.9', fill: P.white, opacity: '0.95' }, faceG);
      });
      // mustache goes under the nose - the reference's nose overlaps it
      el('path', { d: STACHE_D, fill: P.stache }, faceG);
      el('ellipse', { cx: '189.6', cy: '146.5', rx: '9', ry: '6.7', fill: P.nose }, faceG);
      el('ellipse', { cx: '186.6', cy: '143.6', rx: '3.2', ry: '2.1', fill: '#E9958A', opacity: '0.85' }, faceG);
    } else {
      el('path', { fill: '#AD5C51', d: NOSE_D }, faceG);
    }
    const mouthG = el('g', { id: id('mouth') }, faceG);
    const tongue = el('path', { id: id('tongue'), fill: '#e58a9b', stroke: '#9b4a5a', 'stroke-width': '0.7', opacity: '0', d: 'M188.5 164' }, mouthG);
    // Plumber's mouth reads as the underside of the mustache (the reference
    // shows no separate mouth), but stays present so CatWave can still widen it
    // and CatGroom's tongue still has something to come out of.
    const mouth = el('path', Object.assign(
      { fill: '#AD5C51', d: MOUTH_D }, isPlumber ? { opacity: '0' } : null), mouthG);
    // Plumber hat - red cap with white M (sits on top of hood, part of bob so it rides body bob)
    // The hat is drawn after the face so it overlaps the hood's top.
    let hatG = null;
    if (isPlumber) {
      hatG = el('g', { id: id('hat') }, bob);
      el('path', { d: HAT_D, fill: P.red, stroke: P.redDk, 'stroke-width': '1.8', 'stroke-linejoin': 'round' }, hatG);
      // crown/brim seam, plus the shade the reference carries just under it
      const brim = el('g', { 'clip-path': url('hatclip') }, hatG);
      el('path', { d: HAT_SEAM_D + ' L320 130 L60 130 Z', fill: P.redDk, opacity: '0.16' }, brim);
      el('path', { d: HAT_SEAM_D, fill: 'none', stroke: P.redDk, 'stroke-width': '2.4', 'stroke-linecap': 'round' }, brim);
      // white M badge - measured circle r 16.5 at (189.2, 25.2)
      el('circle', { cx: '189.2', cy: '25.2', r: '16.5', fill: P.white, stroke: P.redDk, 'stroke-width': '1.1' }, hatG);
      el('text', {
        x: '189.2', y: '36.5', 'text-anchor': 'middle',
        'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif',
        'font-size': '30', 'font-weight': '900', fill: P.red
      }, hatG).textContent = 'M';
    }
    // Plumber overalls - blue bib over the black torso (covers chest/belly, not head)
    if (isPlumber) {
      // Reference overalls measure x 164.7..213.7, y 185.7..264.7 - the bib top
      // sits exactly on the collar, so the shoulder straps are hidden behind the
      // hood and only the bib and its two buttons ever show.
      const over = el('g', { id: id('plumber-overalls') }, bob);
      const bibAttr = { fill: P.blue, stroke: P.blueDk, 'stroke-width': '1.2', 'stroke-linejoin': 'round' };
      el('path', Object.assign({ d: 'M168.9 185.7 L176.5 185.7 L177.4 206 L169.8 206 Z' }, bibAttr), over);
      el('path', Object.assign({ d: 'M201.8 185.7 L209.5 185.7 L208.6 206 L201 206 Z' }, bibAttr), over);
      // Bib stops at y 243, where the reference's legs split - below that the
      // blue limbs are the legs, and they have to stay free to swing.
      el('path', Object.assign({ d: 'M165.5 200 L213 200 L212.5 243 L166 243 Z' }, bibAttr), over);
      el('circle', { cx: '172.5', cy: '202', r: '4.6', fill: P.yellow, stroke: '#F9A825', 'stroke-width': '0.9' }, over);
      el('circle', { cx: '205.5', cy: '202', r: '4.6', fill: P.yellow, stroke: '#F9A825', 'stroke-width': '0.9' }, over);
    }

    // grooming hand must occlude the muzzle it is lifted to
    // Both fillerWrap and wrap must move to the end, fillerWrap first so it's behind wrap
    if (freeHand >= 0) {
      if (fillerWraps[freeHand]) bob.appendChild(fillerWraps[freeHand]);
      bob.appendChild(limbWraps[freeHand]);
    }

    return {
      svg, root, bob, torso, faceG, mouthG, mouth, tongue,
      eyeL, eyeR, pupilL, pupilR, whiskL, whiskR, earGs,
      limbGs, tailG, suckerG, tailTipG, dropG, shadow, ripples, puddle, armG
    };
  }

  // -------------------------------------------------------------- animation

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const smooth = t => (t = clamp(t, 0, 1), t * t * (3 - 2 * t));
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Advance a pooled ripple set; call once per frame. */
  function stepRipples(ripples, dt, life, rx, ry) {
    for (const r of ripples) {
      if (r.life < 0) continue;
      r.life += dt;
      const t = r.life / (life || 520);
      if (t >= 1) { r.life = -1; r.e.setAttribute('display', 'none'); continue; }
      r.e.setAttribute('rx', (3 + t * (rx || 24)).toFixed(1));
      r.e.setAttribute('ry', (1.2 + t * (ry || 5.5)).toFixed(1));
      r.e.setAttribute('opacity', (0.55 * (1 - t)).toFixed(2));
    }
  }

  function spawnRipple(ripples, x, y) {
    const r = ripples.find(r => r.life < 0) || ripples[0];
    r.life = 0;
    r.e.setAttribute('display', '');
    r.e.setAttribute('cx', x.toFixed(1));
    r.e.setAttribute('cy', y.toFixed(1));
  }

  /**
   * Eyelids. `amount` 0 = open, 1 = shut; pass `amountR` to drive the right eye
   * separately, which is all a wink is. Scaling the eye paths about the eye line
   * is safe: they sit wholly inside the peach face, so no seam to tear.
   */
  function setLids(h, amount, amountR) {
    lid(h.eyeL, h.pupilL, amount);
    lid(h.eyeR, h.pupilR, amountR == null ? amount : amountR);
  }

  function lid(eye, pupil, amount) {
    const a = clamp(amount, 0, 1), y = GEO.eyeY;
    if (a < 0.001) {
      eye.removeAttribute('transform');
      pupil.removeAttribute('transform');
      return;
    }
    eye.setAttribute('transform',
      `translate(0 ${y}) scale(1 ${(1 - 0.9 * a).toFixed(4)}) translate(0 ${-y})`);
    pupil.setAttribute('transform',
      `translate(0 ${y}) scale(1 ${(1 - 0.94 * a).toFixed(4)}) translate(0 ${-y})`);
  }

  /**
   * Tail + the suckers and droplet that ride it, all about the same hinge.
   * `angle` swings the whole curl; `whip` bends it, carrying the tip that many
   * extra units across the sickle's axis while the root stays put - the tail
   * equivalent of a cat's tip-led flick, and the reason a swish reads as one
   * motion travelling outward instead of a rigid board pivoting.
   */
  function setTail(h, angle, dropLag, whip) {
    const { x, y } = GEO.tailHinge;
    const t = `rotate(${angle.toFixed(2)} ${x} ${y}) ` + tailWhip(whip);
    h.tailG.setAttribute('transform', t);
    h.suckerG.setAttribute('transform', t);
    if (h.tailTipG) h.tailTipG.setAttribute('transform', t);
    // the droplet is hanging fluid: it trails the curl and swings on its own
    const lag = angle + (dropLag || 0);
    h.dropG.setAttribute('transform',
      `rotate(${lag.toFixed(2)} ${x} ${y}) ` + tailWhip(whip) +
      ` rotate(${(lag * 0.6).toFixed(2)} ${GEO.dropAt.x} ${GEO.dropAt.y})`);
  }

  /** Shear across the tail's own axis: fixes the root, displaces the tip by `whip`. */
  function tailWhip(whip) {
    if (!whip) return '';
    const { x, y } = GEO.tailHinge, A = GEO.tailAxis;
    const s = (whip / A.len).toFixed(4);
    return `translate(${x} ${y}) rotate(${A.deg.toFixed(4)}) matrix(1 ${s} 0 1 0 0) ` +
      `rotate(${(-A.deg).toFixed(4)}) translate(${-x} ${-y})`;
  }

  /**
   * Pose an ear. `lean` carries the tip that many units outward along the head
   * (negative leans it in), `perk` that many units further from the base.
   *
   * Both are shears/scales in the frame of the ear's base chord, so the chord
   * itself is a fixed *line* - see SEAM RULES 3. That is what buys an ear a
   * 6-unit flick: the same motion as a rotation would put ~3 units of step into
   * the notch between the ears, while this puts under half a unit at the band.
   */
  function setEar(h, i, lean, perk) {
    const E = EARS[i], g = h.earGs[i];
    if (!g) return;
    // tip v is -depth, so a positive outward lean needs the opposite shear sign
    const sh = -E.out * (lean || 0) / E.depth;
    const ky = 1 + (perk || 0) / E.depth;
    g.setAttribute('transform',
      `translate(${E.a.x} ${E.a.y}) rotate(${E.deg.toFixed(4)}) ` +
      `matrix(1 0 ${sh.toFixed(5)} ${ky.toFixed(5)} 0 0) ` +
      `rotate(${(-E.deg).toFixed(4)}) translate(${-E.a.x} ${-E.a.y})`);
  }

  /**
   * Rotation + axial stretch that puts a limb's paw on `target`.
   * Returns { deg, k }: rotate `deg` about the hinge, having scaled the limb by
   * `k` along its own hanging axis. Solved exactly, so the paw lands on `target`.
   *
   * A rigid limb cannot reach far - this one is ~52 units from its shoulder - so
   * anything that has to touch the face or wave beside the head stretches, the
   * standard cartoon reach. It is cheap on this cat because the shaft runs up
   * across the black chest, where only the paw reads against another colour.
   */
  function solveReach(limb, target) {
    const px = limb.hinge, py = LEG_CLIP_Y;
    const bx = limb.foot.x - px, by = limb.foot.y - py;
    const need = Math.hypot(target.x - px, target.y - py);
    // scaling y by k takes the paw offset to (bx, by*k); solve |(bx, by*k)| = need
    const k = Math.sqrt(Math.max(1, need * need - bx * bx)) / Math.abs(by);
    const deg = (Math.atan2(target.y - py, target.x - px) - Math.atan2(by * k, bx)) * 180 / Math.PI;
    return { deg, k };
  }

  /**
   * Two-bone version of solveReach: puts the paw on `target` with the elbow
   * held at `bendDeg` instead of running the arm out as one straight bar.
   *
   * With the elbow bent the chain is shorter end to end, so hitting the same
   * point costs more stretch - which is why `target` wants pulling in when you
   * add bend, not leaving where a straight arm needed it.
   *
   * Writing a = (0, L1) for the upper bone and b = (bx, L2) for the forearm in
   * rest space, a stretch k puts the wrist at m = (0, L1 k) + R(bend)(bx, L2 k)
   * from the shoulder. |m| = |target - S| is a quadratic in k, so the stretch is
   * exact rather than iterated, and the shoulder angle then just aims m at the
   * target.
   */
  function solveArm(limb, target, bendDeg) {
    const Sx = limb.hinge, Sy = LEG_CLIP_Y;
    const L1 = limb.elbow - Sy;            // upper bone, rest length
    const L2 = limb.foot.y - limb.elbow;   // forearm, rest length
    const bx = limb.foot.x - Sx;           // the paw's sideways offset from the shaft
    const b = (bendDeg || 0) * Math.PI / 180, cb = Math.cos(b), sb = Math.sin(b);
    const Dx = target.x - Sx, Dy = target.y - Sy;
    const d = Math.hypot(Dx, Dy);
    const A = L2 * L2 * sb * sb + (L1 + L2 * cb) * (L1 + L2 * cb);
    const B = 2 * bx * sb * L1;
    const C = bx * bx - d * d;
    const k = Math.max(0.2, (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A));
    const mx = bx * cb - L2 * sb * k;
    const my = L1 * k + bx * sb + L2 * cb * k;
    const deg = (Math.atan2(Dy, Dx) - Math.atan2(my, mx)) * 180 / Math.PI;
    return { deg, bend: bendDeg || 0, k: k };
  }

  /**
   * Apply a solveArm() pose. `move` takes the shoulder rotation only; each bone
   * carries its own axial scale, so nothing is ever scaled after being rotated
   * (that would shear the forearm into a wedge). The elbow disc gets the
   * translation but not the scale, so it stays a circle and keeps covering the
   * joint at every bend.
   */
  function setArm(h, pose) {
    const a = h.armG; if (!a) return;
    const L = a.limb, Sx = L.hinge, Sy = LEG_CLIP_Y;
    const L1 = L.elbow - Sy, L2 = L.foot.y - L.elbow, Ex = L.hinge, Ey = L.elbow;
    const k = pose.k, dy = (L1 * (k - 1)).toFixed(3);
    a.upper.setAttribute('transform',
      `translate(${Sx} ${Sy}) scale(1 ${k.toFixed(4)}) translate(${-Sx} ${-Sy})`);
    a.elbow.setAttribute('transform', `translate(0 ${dy})`);
    a.fore.setAttribute('transform',
      `translate(0 ${dy}) rotate(${pose.bend.toFixed(2)} ${Ex} ${Ey}) ` +
      `translate(${Ex} ${Ey}) scale(1 ${k.toFixed(4)}) translate(${-Ex} ${-Ey})`);
  }

  /** Apply a solveReach() pose (or any deg/k pair) to a limb's moving group. */
  function setReach(g, limb, deg, k) {
    const px = limb.hinge, py = LEG_CLIP_Y;
    g.setAttribute('transform',
      `rotate(${deg.toFixed(2)} ${px} ${py}) translate(${px} ${py}) ` +
      `scale(1 ${k.toFixed(4)}) translate(${-px} ${-py})`);
  }

  /**
   * Pose a limb: `angle` swings it about its hinge, `lift` raises the paw by
   * that many units (negative = up).
   *
   * The lift is an axial scale about the hinge, not a translate - the hinge has
   * to stay a fixed point or the seam steps sideways. See SEAM RULES 1. There
   * is no x parameter; use swayDeg().
   */
  function setLimb(g, limb, lift, angle) {
    const x = limb.hinge, y = LEG_CLIP_Y;
    const k = 1 + lift / (limb.foot.y - y);
    g.setAttribute('transform',
      `rotate(${angle.toFixed(2)} ${x} ${y}) ` +
      `translate(${x} ${y}) scale(1 ${k.toFixed(4)}) translate(${-x} ${-y})`);
  }

  /**
   * Degrees of hinge rotation that carry a limb's paw `dx` sideways. Stance
   * limbs use this to hold their paws still while the body sways: the hinge sits
   * on LEG_CLIP_Y, so the rotation displaces nothing at the hip line and the
   * full dx at the paw. A whole unit of sway costs well under a degree.
   */
  function swayDeg(limb, dx) {
    const reach = limb.foot.y - LEG_CLIP_Y;
    return -Math.asin(clamp(dx / reach, -1, 1)) * 180 / Math.PI;
  }

  global.CatRig = {
    NS, el, rect, ensureStyle, build,
    GEO, LIMBS, EARS, CAT_D, TAIL_D,
    LEG_CLIP_Y, LEG_HOLE_Y, TAIL_HOLE_X, EAR_BAND,
    clamp, smooth, lerp,
    stepRipples, spawnRipple, setLids, setTail, setLimb, swayDeg,
    setEar, solveReach, setReach, solveArm, setArm, ELBOW_T
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CatRig;
})(typeof window !== 'undefined' ? window : this);
