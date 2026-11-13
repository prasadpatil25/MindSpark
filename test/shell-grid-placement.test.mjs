// The markdown pane must always share the stage's grid row, in every app
// layout, with or without the tabbed workspace.
//
// ensureMdPane() builds #mdPane once and never tears it down - it registers a
// window resize listener - so after the split editor has been visited once the
// element is a permanent grid item. applyUiLayout() meanwhile drops .md-ready
// on every switch. A closed pane therefore still needs a cell, and the cell it
// gets must not be one another element needs.
//
// The single-row shells (classic/mirror, rail, zen) put the pane on row 1,
// which is correct while row 1 is the only row. Turn the tabbed workspace on
// and row 1 becomes the 30px tab strip: a width:0 flex column of editor markup
// has a huge max-content height, an `auto` track is sized to max-content
// before any 1fr track is fed, so row 1 took the whole viewport and the stage
// collapsed to nothing - tab strip stranded at the bottom of a blank screen.
// Their corrections existed but were gated on .md-ready, the one class that is
// guaranteed absent at that moment.
//
// Real grid layout cannot be run here, so this resolves the cascade over the
// sheet the way a browser would - specificity then source order - for the body
// class sets applyUiLayout() actually produces.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, decls, spec, cmpSpec } from './helpers/css-audit.mjs';
import { extractConst } from './helpers/load-app-fns.mjs';

// What applyUiLayout() toggles onto <body> for each id. `mirror` reuses every
// classic rule and adds its own, which is why it is two classes.
const LAYOUT_CLASSES = {
  modern: [], classic: ['ui-classic'], mirror: ['ui-classic', 'ui-mirror'],
  rail: ['ui-rail'], zen: ['ui-zen'], dock: ['ui-dock'], split: ['ui-split'],
  minimal: ['ui-minimal'], outline: ['ui-outline'],
};

// Does `sel` apply to a <body> carrying exactly `state`, for element `target`?
function matches(sel, target, state) {
  const s = sel.trim();
  if (!s.endsWith(target)) return false;
  let head = s.slice(0, s.length - target.length).trim();
  if (head && head !== 'body' && !head.startsWith('body.') && !head.startsWith('body:')) return false;
  // `:not(.x)` means x must be absent; every other .class must be present.
  for (const m of head.matchAll(/:not\(\.([\w-]+)\)/g)) if (state.has(m[1])) return false;
  head = head.replace(/:not\([^)]*\)/g, '');
  if (/[:[]/.test(head)) return false;            // other pseudo/attr states are out of scope
  for (const m of head.matchAll(/\.([\w-]+)/g)) if (!state.has(m[1])) return false;
  return true;
}

function winning(target, state, prop) {
  let best = null;
  RULES.forEach((r, i) => {
    if (r.sel.startsWith('@')) return;            // width-dependent, not the desktop default
    for (const sel of r.sel.split(',')) {
      if (!matches(sel, target, state)) continue;
      const d = decls(r.body);
      if (!(prop in d)) continue;
      const sp = spec(sel.trim());
      if (!best || cmpSpec(sp, best.sp) > 0 || (cmpSpec(sp, best.sp) === 0 && i >= best.i)) {
        best = { sp, i, value: d[prop], sel: sel.trim() };
      }
    }
  });
  return best;
}

describe('app shell grid placement', () => {
  test('the layout list still matches the ones this test knows about', () => {
    const ids = extractConst('UI_LAYOUTS').map(l => l.id).sort();
    assert.deepEqual(ids, Object.keys(LAYOUT_CLASSES).sort(),
      'UI_LAYOUTS changed - add the new layout to LAYOUT_CLASSES so it is covered here');
  });

  for (const [id, classes] of Object.entries(LAYOUT_CLASSES)) {
    for (const tabs of [false, true]) {
      for (const mdReady of [false, true]) {
        const label = `${id}${tabs ? ' + tabs' : ''}${mdReady ? ' + md-ready' : ''}`;
        test(`${label}: the markdown pane shares the stage's row`, () => {
          const state = new Set([...classes, ...(tabs ? ['tabs-on'] : []), ...(mdReady ? ['md-ready'] : [])]);
          const pane = winning('#mdPane', state, 'grid-row');
          const stage = winning('.stage', state, 'grid-row');
          assert.ok(pane, 'no rule places #mdPane at all');
          assert.ok(stage, 'no rule places .stage at all');
          assert.equal(pane.value, stage.value,
            `#mdPane is on row ${pane.value} (${pane.sel}) but the stage is on row ${stage.value} ` +
            `(${stage.sel}). A closed pane in a row of its own inflates that track and starves the stage.`);
        });

        if (tabs) {
          test(`${label}: the markdown pane is not parked on the tab strip's row`, () => {
            const state = new Set([...classes, 'tabs-on', ...(mdReady ? ['md-ready'] : [])]);
            const pane = winning('#mdPane', state, 'grid-row');
            const strip = winning('#tabStrip', state, 'grid-row');
            assert.ok(strip, 'no rule places #tabStrip at all');
            assert.notEqual(pane.value, strip.value,
              `#mdPane and #tabStrip are both on row ${pane.value} (${pane.sel} vs ${strip.sel})`);
          });
        }
      }
    }
  }
});

describe('breadcrumb placement', () => {
  // The modern shell puts the canvas in the grid's second column, to the right
  // of the sidebar. A viewport-fixed pill at left:14px therefore sat over the
  // sidebar, not the scene. Anchoring it to .stage also keeps it centred when
  // the sidebar is resized or collapsed.
  test('the modern shell anchors the breadcrumb to the stage and centres it', () => {
    const state = new Set();
    assert.equal(winning('.breadcrumb', state, 'position').value, 'absolute');
    assert.equal(winning('.breadcrumb', state, 'top').value, '14px');
    assert.equal(winning('.breadcrumb', state, 'left').value, '50%');
    assert.match(winning('.breadcrumb', state, 'transform').value, /translateX\(-50%\)/);
    assert.match(winning('.breadcrumb.shown', state, 'transform').value, /translateX\(-50%\) translateY\(0\)/);
  });

  test('the shared view keeps the breadcrumb fixed below the banner', () => {
    const state = new Set(['shared-view']);
    assert.equal(winning('.breadcrumb', state, 'position').value, 'fixed');
    assert.equal(winning('.breadcrumb', state, 'top').value, '97px');
    assert.equal(winning('.breadcrumb', state, 'left').value, '50%');
    assert.match(winning('.breadcrumb', state, 'transform').value, /translateX\(-50%\)/);
    assert.match(winning('.breadcrumb.shown', state, 'transform').value, /translateX\(-50%\) translateY\(0\)/);
  });
});
