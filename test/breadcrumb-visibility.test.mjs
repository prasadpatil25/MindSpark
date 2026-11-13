// The breadcrumb is a readout of where the selection sits, so a Modern bars
// path must not depend on the pointer happening to cross the overview chip at
// the far end of the status bar. It used to: syncBreadcrumb() required `_ov`,
// which only the chip's mouseenter/focusin listeners set, so the pill appeared
// only while the mouse was over that chip.
//
// The docked shells keep the hover reveal, and focus mode keeps hiding the
// breadcrumb in every layout. These tests drive the real syncBreadcrumb()
// lifted out of public/app.js, with the body classes and breadcrumb state
// stubbed, so they fail if the reveal rules drift.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

function makeClassList(...names) {
  const set = new Set(names);
  return { contains: name => set.has(name) };
}

function makeBreadcrumb({ has = true, ov = false } = {}) {
  const bc = { _has: has, _ov: ov, shown: false };
  bc.classList = { toggle(name, on) { bc.shown = !!on; } };
  return bc;
}

function isShown(bodyClasses, state) {
  const bc = makeBreadcrumb(state);
  const body = { classList: makeClassList(...bodyClasses) };
  const { syncBreadcrumb } = loadFns(['syncBreadcrumb'], {
    _breadcrumbEl: bc,
    document: { body },
  });
  syncBreadcrumb();
  return bc.shown;
}

describe('breadcrumb visibility', () => {
  test('Modern bars shows a path without hovering the overview chip', () => {
    assert.equal(isShown([], { has: true, ov: false }), true);
  });

  test('Modern bars still hides the breadcrumb when the selection has no path', () => {
    assert.equal(isShown([], { has: false, ov: true }), false);
  });

  test('focus mode hides the breadcrumb in Modern bars', () => {
    assert.equal(isShown(['focus-mode'], { has: true, ov: true }), false);
  });

  test('the classic shells keep the always-on behavior they already had', () => {
    for (const shell of ['ui-classic', 'ui-rail', 'ui-zen']) {
      assert.equal(isShown([shell], { has: true, ov: false }), true, shell);
      assert.equal(isShown([shell, 'focus-mode'], { has: true, ov: false }), false, shell);
    }
  });

  test('the docked shells keep their hover reveal', () => {
    for (const shell of ['ui-dock', 'ui-split', 'ui-minimal', 'ui-outline']) {
      assert.equal(isShown([shell], { has: true, ov: false }), false, `${shell} without hover`);
      assert.equal(isShown([shell], { has: true, ov: true }), true, `${shell} with hover`);
    }
  });
});
