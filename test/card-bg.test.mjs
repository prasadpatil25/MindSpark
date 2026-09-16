// A translucent card colour in the per-map theme settings ("nodeBg":
// "#ffffff80") made every dialog see-through: --node-bg is each theme's
// surface colour and paints the Preferences card, the sign-in form, the
// Build Prompt panel, pickers and inputs as well as the map cards, and the
// nodeBg knob wrote straight to it. The cards now read their own --card-bg
// (derived from --node-bg, so every theme looks as before) and the knob
// writes only that. This pins the split so a later rule cannot undo it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

// Every rule in styles.css as [selector, body], comments stripped.
function rules() {
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(src))) out.push([m[1].trim().replace(/\s+/g, ' '), m[2]]);
  return out;
}
const isNodeRule = sel => /(^|[ ,>+~])\.node(\b|[.:\[])/.test(sel) || /^#viewport\[data-style/.test(sel);

describe('the map cards have their own colour variable', () => {
  test('--card-bg is defined once on :root and derives from the theme surface', () => {
    assert.match(CSS, /:root\{[^}]*--card-bg:var\(--node-bg\);/);
    const defs = CSS.match(/--card-bg:/g) || [];
    assert.equal(defs.length, 1, 'no theme or look may redefine it - the knob writes it inline on :root');
  });

  test('every .node rule that paints a fill or border from the surface colour reads --card-bg', () => {
    const wrong = rules().filter(([sel, body]) => isNodeRule(sel) && /var\(--node-bg\b/.test(body)).map(([sel]) => sel);
    assert.deepEqual(wrong, [], 'node rules must read var(--card-bg), not var(--node-bg)');
    const right = rules().filter(([sel, body]) => isNodeRule(sel) && /var\(--card-bg\b/.test(body));
    assert.ok(right.length >= 10, `expected the node rules on --card-bg, found ${right.length}`);
    assert.ok(right.some(([sel]) => sel === '.node'), 'the base .node fill');
    assert.match(CSS, /--zebra-1:color-mix\(in srgb, var\(--card-bg\)/, 'zebra striping is a card fill too');
  });

  test('dialogs, panels and inputs keep the opaque theme surface (--node-bg) and never read --card-bg', () => {
    const surfaces = ['.vf-card', '.login-card', '.donate-card', '.kb-card', '.bp-panel', '.hist-panel', '.picker', '.pf-in', '.pf-select'];
    for (const s of surfaces) {
      const r = rules().find(([sel]) => sel === s);
      assert.ok(r, `rule ${s} not found`);
      assert.match(r[1], /var\(--node-bg\b/, `${s} paints with the theme surface`);
      assert.doesNotMatch(r[1], /var\(--card-bg\b/, `${s} must not follow the card colour`);
    }
    const leaks = rules().filter(([sel, body]) => !isNodeRule(sel) && !/^:root$/.test(sel) && /var\(--card-bg\b/.test(body)).map(([sel]) => sel);
    assert.deepEqual(leaks, [], 'only card rules may read --card-bg');
  });
});

describe('the nodeBg theme setting reaches the cards only', () => {
  const VARS = extractConst('THEME_CONFIG_VARS');
  const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

  test('the knob writes --card-bg; the other knobs are unchanged', () => {
    assert.equal(VARS.nodeBg, '--card-bg');
    assert.deepEqual({ ...VARS, nodeBg: undefined }, { paper: '--paper', ink: '--ink', accent: '--accent', nodeBg: undefined, line: '--line', glow: '--stage-glow' });
  });

  test('a custom theme still supplies the default card colour from its --node-bg', () => {
    assert.match(APP, /const THEME_CONFIG_PALETTE = { ...THEME_CONFIG_VARS, nodeBg:'--node-bg' };/);
    const src = extractFunction('applyThemeConfigVars');
    assert.match(src, /custom\.vars\[THEME_CONFIG_PALETTE\[k\]\]/);
  });

  test('PNG export draws the cards with the card colour, falling back to the surface', () => {
    const src = extractFunction('exportPNG');
    assert.match(src, /css\('--card-bg'\)\s*\|\|\s*css\('--node-bg'\)/);
  });

  test('the map-style preview thumbnails are cards too', () => {
    assert.equal((APP.match(/fill="var\(--node-bg,#fff\)"/g) || []).length, 0);
    assert.ok((APP.match(/fill="var\(--card-bg,#fff\)"/g) || []).length >= 8);
  });
});
