// A Look is font plus non-node chrome texture, independent of Colour Theme and
// Map Style (see the note above LOOKS in public/app.js). Adding one means
// touching FOUR places, and the fourth is the one that gets forgotten:
//
//   1. LOOKS                  - the picker entry
//   2. LOOK_CONFIG_DEFAULTS   - font / nodeSize / radius
//   3. :root[data-look=...]   - the CSS in public/styles.css
//   4. drawLookBg()           - the canvas re-implementation used by PNG export
//
// Miss (4) and nothing breaks on screen; the exported image just quietly comes
// out without the texture. Four looks are already in that state, which is what
// prompted this file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const LOOKS = extractConst('LOOKS');

// 'office' is the default and is achieved by the ABSENCE of data-look, so it
// deliberately has no CSS block and nothing to paint.
const IMPLICIT = 'office';

/** ids named in LOOK_CONFIG_DEFAULTS. */
function configIds() {
  const at = APP.indexOf('const LOOK_CONFIG_DEFAULTS = {');
  const body = APP.slice(at, APP.indexOf('\n};', at));
  return [...body.matchAll(/^\s*'?([a-z-]+)'?\s*:\s*\{/gm)].map(m => m[1]);
}

/** ids drawLookBg() knows how to reproduce on canvas. */
function paintedIds() {
  const at = APP.indexOf('const drawLookBg');
  const body = APP.slice(at, APP.indexOf('\n  };', at));
  return [...new Set([...body.matchAll(/look==='([a-z-]+)'/g)].map(m => m[1]))];
}

/** Total bytes of every rule for one look. */
function lookCssBytes(id) {
  const sel = `:root[data-look="${id}"]`;
  let at = CSS.indexOf(sel), guard = 0, bytes = 0;
  while (at !== -1 && guard++ < 400) { bytes += CSS.indexOf('}', at) + 1 - at; at = CSS.indexOf(sel, at + 1); }
  return bytes;
}

/** Looks whose CSS actually gives .stage a texture - only those need painting. */
function looksWithStageTexture() {
  return LOOKS.map(l => l.id).filter(id => {
    const at = CSS.indexOf(`:root[data-look="${id}"] .stage{`);
    if (at === -1) return false;
    return CSS.slice(at, CSS.indexOf('\n  }', at)).includes('background-image');
  });
}

// Empty, and it should stay that way: every look that textures .stage now
// reproduces it in the PNG export. scientist, architect, alien and psycho sat
// here until their painter branches were written.
const EXPORT_TEXTURE_MISSING = [];
// Empty: `sketchpad` sat here with no look to belong to until it was deleted.
const ORPHAN_CONFIG = [];
// Names that deliberately do NOT carry a <br>. Every other look reads as a
// phrase that wants breaking ("in the / Office", "back to / School"), so the
// rule is worth keeping by default. "I am Groot" is the whole joke in two
// words and splitting it across lines would spoil the delivery. Cards are a
// fixed 131x45 either way, so this costs nothing in layout. Listed rather than
// dropping the rule, so the next name still has to justify itself.
const SINGLE_LINE_NAMES = ['groot'];
// Empty, and it should stay that way. Four looks were on this list: psycho
// (#ff0033), alien (#ff6b6b), desert (#966e3a) and groot (a converted raster
// whose ~5,200 fills carried their own colours). Two of them were invisible
// until this scan started decoding %23, and groot's until it started reading
// rgba() - which is why it now reads all three notations.
const HARDCODED_HUE = [];

// A grey is a contrast choice, not a theme colour. The tolerance is for
// artwork that is nominally greyscale but carries a point or two of drift
// between channels; anything wider is a real hue someone chose.
const NEUTRAL_SPREAD = 12;
function neutralRGB(r, g, b) { return Math.max(r, g, b) - Math.min(r, g, b) <= NEUTRAL_SPREAD; }
function isNeutral(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return neutralRGB(r, g, b);
}

/** Every fixed colour in a rule, whatever notation it is written in. */
function fixedHues(rule) {
  const out = [];
  // #rgb / #rrggbb, and %23... for a colour inside an SVG data: URI, which is
  // where one is easiest to hide.
  const hexes = [...(rule.match(/#[0-9a-fA-F]{3,8}\b/g) || []),
                 ...(rule.match(/%23[0-9a-fA-F]{3,8}\b/g) || []).map(h => '#' + h.slice(3))];
  for (const hex of hexes) if (!isNeutral(hex)) out.push(hex);
  // rgb()/rgba(), which is how a raster converted to SVG writes its pixels.
  for (const m of rule.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    if (!neutralRGB(r, g, b)) out.push(`rgb(${r},${g},${b})`);
  }
  return out;
}

describe('look registry', () => {
  test('ids are unique and every look is fully declared', () => {
    const ids = LOOKS.map(l => l.id);
    assert.deepEqual(ids, [...new Set(ids)], 'duplicate look id');
    for (const l of LOOKS) {
      assert.match(l.id, /^[a-z][a-z-]*$/, `${l.id} is used as a data-look attribute value`);
      assert.equal(typeof l.name, 'string');
      assert.ok(l.name.trim().length, `${l.id} has no name`);
      assert.equal(typeof l.font, 'string');
    }
  });

  test('every name completes the panel\'s "I am" label', () => {
    // public/app.js renders `<div class="tp-label">I am` and each card finishes
    // the sentence, which is why "Groot" needs no punchline of its own.
    //
    // The <br> is about how the text wraps, NOT about card geometry: every card
    // measures 131x45 whatever its name, so a one-line name simply sits centred
    // with one line instead of two. (An earlier version of this comment claimed
    // the break kept the cards a uniform height. Measured in the browser, it
    // does not - which is what makes the exemption below cheap.)
    assert.ok(APP.includes('<div class="tp-label">I am'),
      'the "I am" label is gone; the look names no longer read as sentences');
    for (const l of LOOKS) {
      if (!SINGLE_LINE_NAMES.includes(l.id)) {
        assert.ok(l.name.includes('<br>'), `${l.id}: name must break into two lines`);
      }
      assert.ok(!/^I am/i.test(l.name.replace(/<br>/g, ' ').trim()),
        `${l.id}: the label already says "I am", so the name must not repeat it`);
    }
    // The exemption is only for the line break. Every name, exempt or not, must
    // still finish the sentence and must still be short enough to fit a card.
    for (const id of SINGLE_LINE_NAMES) {
      const l = LOOKS.find(x => x.id === id);
      assert.ok(l, `SINGLE_LINE_NAMES names "${id}", which is not a look any more`);
      assert.ok(!l.name.includes('<br>'),
        `${id} now breaks into two lines - remove it from SINGLE_LINE_NAMES`);
      assert.ok(l.name.trim().length <= 12,
        `${id} is on one line, so it has a card's full width and no more`);
    }
  });

  test('every look has config defaults, in bounds', () => {
    const cfg = extractConst('LOOK_CONFIG_DEFAULTS');
    const bounds = extractConst('LOOK_CONFIG_BOUNDS');
    for (const l of LOOKS) {
      const c = cfg[l.id];
      assert.ok(c, `${l.id} has no LOOK_CONFIG_DEFAULTS entry, so its size and radius are the office defaults`);
      assert.ok(c.nodeSize >= bounds.nodeSize[0] && c.nodeSize <= bounds.nodeSize[1],
        `${l.id}.nodeSize ${c.nodeSize} is outside ${bounds.nodeSize}, so validateLookConfig would clamp it away`);
      assert.ok(c.radius >= bounds.radius[0] && c.radius <= bounds.radius[1],
        `${l.id}.radius ${c.radius} is outside ${bounds.radius}`);
    }
    const orphans = configIds().filter(id => !LOOKS.some(l => l.id === id));
    assert.deepEqual(orphans, ORPHAN_CONFIG,
      'a LOOK_CONFIG_DEFAULTS entry with no matching look is unreachable; add the look or drop the entry');
  });

  test('every look has a CSS block that sets its font', () => {
    for (const l of LOOKS) {
      if (l.id === IMPLICIT) continue;
      const sel = `:root[data-look="${l.id}"]`;
      assert.ok(CSS.includes(sel), `${l.id} has no ${sel} rule in styles.css, so selecting it changes nothing`);
      assert.ok(CSS.includes(`${sel}{`), `${l.id} must set --sans/--serif on the root selector`);
    }
    // The default must NOT have a block - it is the absence of the attribute.
    assert.ok(!CSS.includes(`:root[data-look="${IMPLICIT}"]`),
      `${IMPLICIT} is the implicit default and must not have its own CSS block`);
  });

  test('a look that paints the stage also paints it into the PNG export', () => {
    const painted = paintedIds();
    const missing = looksWithStageTexture().filter(id => !painted.includes(id));
    assert.deepEqual(missing.sort(), [...EXPORT_TEXTURE_MISSING].sort(),
      'this look gives .stage a background-image but drawLookBg() cannot reproduce it, ' +
      'so its PNG export silently loses the texture. Add a branch in drawLookBg().');
    // Keep the debt list honest: an entry naming a look that no longer exists,
    // or one that has since been fixed, must be removed rather than left.
    for (const id of EXPORT_TEXTURE_MISSING) {
      assert.ok(LOOKS.some(l => l.id === id), `EXPORT_TEXTURE_MISSING names "${id}", which is not a look any more`);
      assert.ok(!painted.includes(id), `${id} now has a painter branch - remove it from EXPORT_TEXTURE_MISSING`);
    }
  });

  test('no look hardcodes a hue instead of using the theme', () => {
    // A Look is colour-independent by contract: colour comes from whichever
    // Colour Theme is active, so a literal hue inside a data-look rule only
    // shows up as wrong on the themes nobody tested against.
    //
    // Greys are not hues and are allowed: `color:#fff` over `background:
    // var(--accent)` is a deliberate contrast pick, not a theme colour.
    const hues = [];
    for (const l of LOOKS) {
      if (l.id === IMPLICIT) continue;
      const sel = `:root[data-look="${l.id}"]`;
      let at = CSS.indexOf(sel), guard = 0;
      while (at !== -1 && guard++ < 300) {
        const rule = CSS.slice(at, CSS.indexOf('}', at) + 1);
        for (const hex of fixedHues(rule)) {
          hues.push({ id: l.id, hex, rule: rule.trim().replace(/\s+/g, ' ').slice(0, 120) });
        }
        at = CSS.indexOf(sel, at + 1);
      }
    }
    assert.deepEqual([...new Set(hues.map(h => h.id))].sort(), [...HARDCODED_HUE].sort(),
      'a look is painting with a fixed hue, so it will clash with themes it was never tried against. ' +
      'Use var(--ink) / var(--accent) / var(--teal) through color-mix instead:\n' +
      [...new Set(hues.map(h => h.id))].map(id => {
        const mine = hues.filter(h => h.id === id);
        return `  ${id}: ${mine.length} fixed colour${mine.length === 1 ? '' : 's'}, e.g. ` +
               `${[...new Set(mine.map(h => h.hex))].slice(0, 3).join(', ')}`;
      }).join('\n'));
  });
});

describe('look animations stay off the main thread', () => {
  // A Look's animation runs for as long as someone has that look selected, so
  // it has to be free. Only transform and opacity are composited; everything
  // else repaints, and a full-viewport layer repainting every frame is the
  // difference between 0ms and 859ms of main thread per 5s on a throttled CPU.
  // That was measured, not assumed - the sailboat waves used to animate
  // background-position and cost exactly that.
  const COMPOSITED = new Set(['transform', 'opacity']);

  /** @keyframes bodies, brace-matched (a regex on `}` bleeds into the next rule). */
  function keyframes() {
    const out = new Map();
    let i = 0;
    while ((i = CSS.indexOf('@keyframes', i)) !== -1) {
      const name = CSS.slice(i).match(/@keyframes\s+([\w-]+)/)[1];
      let j = CSS.indexOf('{', i), depth = 0, k = j;
      for (; k < CSS.length; k++) { if (CSS[k] === '{') depth++; else if (CSS[k] === '}') { depth--; if (!depth) break; } }
      out.set(name, CSS.slice(j + 1, k));
      i = k;
    }
    return out;
  }

  test('any animation a look runs touches only composited properties', () => {
    const kf = keyframes();
    const offenders = [];
    for (const m of CSS.matchAll(/:root\[data-look="([a-z-]+)"\][^{]*\{([^}]*)\}/g)) {
      const decl = m[2].match(/animation\s*:\s*([^;]+)/);
      if (!decl) continue;
      const name = decl[1].trim().split(/\s+/)[0];
      const body = kf.get(name);
      assert.ok(body, `${m[1]} runs @keyframes ${name}, which does not exist`);
      const props = [...new Set([...body.matchAll(/(?:^|[;{]\s*)([a-z-]+)\s*:/g)].map(x => x[1]))];
      const bad = props.filter(x => !COMPOSITED.has(x));
      if (bad.length) offenders.push(`${m[1]} / ${name}: ${bad.join(', ')}`);
    }
    assert.deepEqual(offenders, [],
      'a look animates a property the compositor cannot handle, so every frame repaints:\n  ' +
      offenders.join('\n  ') + '\nAnimate transform/opacity instead.');
  });

  test('an animated look layer is promoted and contained', () => {
    // will-change:transform gives it its own compositing layer; contain:paint
    // stops invalidation escaping into the stage around it.
    const at = CSS.indexOf('.wave-layer{');
    assert.notEqual(at, -1, 'the sailboat wave layer is gone');
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    assert.match(rule, /will-change:\s*transform/, 'the wave layer must be promoted');
    assert.ok(!/will-change:[^;]*background/.test(rule),
      'will-change on background-position promotes nothing and just costs memory');
    assert.match(rule, /contain:\s*paint/);
  });

  test('nothing drives the wave from a rAF loop any more', () => {
    assert.ok(!/_tickWave|_waveRAF/.test(APP),
      'the wave is CSS-driven now; a rAF loop writing styles puts it back on the main thread');
    assert.ok(!/\.style\.backgroundPosition/.test(APP),
      'background-position cannot be composited - animate transform instead');
  });
});

describe('every look stays cheap enough to ship', () => {
  // styles.css and app.js are precached by sw.js and bundled into the pkg
  // builds, so a Look's CSS is downloaded by every visitor whatever look they
  // picked. That makes embedded artwork a cost paid by everyone for a theme
  // almost nobody has selected.
  //
  // The cap is generous on purpose: the largest hand-written Look is under
  // 8 KB, so 16 KB leaves room to grow and still catches an embedded raster by
  // an order of magnitude. A pixel-per-<rect> SVG lands around 500 KB.
  const MAX_LOOK_CSS = 16 * 1024;

  test('no look block is large enough to be embedded artwork', () => {
    const sizes = LOOKS.map(l => [l.id, lookCssBytes(l.id)]).sort((a, b) => b[1] - a[1]);
    const over = sizes.filter(([, b]) => b > MAX_LOOK_CSS);
    assert.deepEqual(over, [],
      'a look\'s CSS is far past what styling needs, which means artwork is embedded in it. ' +
      'Put the image in public/ as a real .png or .webp and reference it by URL: img-src allows ' +
      "'self', it loads only for the look that uses it, and it stays out of the bundle everyone " +
      'downloads.\n' + sizes.map(([id, b]) => `  ${id}: ${(b / 1024).toFixed(1)} KB`).join('\n'));
  });
});
