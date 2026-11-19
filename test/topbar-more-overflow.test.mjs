// Narrow windows used to lose the right end of the top bar. The floating
// shells (classic, mirror) were single-row nowrap pills, so at ~768px the
// token counter was shoved ~44px past the edge and the save pill ~112px
// past it; at 375px even the search/theme/more cluster ran off the right
// side. The modern shell wrapped but its status-bar pills hide by design on
// phones, and applyUiLayout re-added the sidebar on phones, covering the
// whole bar. Three fixes, pinned here:
//   1. Below 1100px the least-used actions collapse into #moreBtn (.tb-more)
//      and the .tb-sec buttons hide (search and theme stay visible: the
//      search overlay anchors to #searchBtn, the theme panel to #themeBtn).
//   2. The classic floating topbar wraps instead of nowrap, so the pills the
//      classic shell moves into the bar land on a second row, in-view.
//   3. applyUiLayout's restoreShell keeps the phone-only collapsed sidebar.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const SEC_IDS = ['varsBtn', 'prefsBtn', 'menuExport', 'focusBtn', 'outlineBtn', 'tabsBtn', 'donateBtn'];

function buttonTag(id) {
  const m = HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
  assert.ok(m, `#${id} must exist`);
  return m[0];
}

describe('the top bar overflow menu', () => {
  test('the seven least-used buttons carry tb-sec, search and theme do not', () => {
    for (const id of SEC_IDS) assert.match(buttonTag(id), /tb-sec/, `#${id} must collapse into the overflow menu`);
    assert.doesNotMatch(buttonTag('searchBtn'), /tb-sec/, 'search anchors the find overlay - stays visible');
    assert.doesNotMatch(buttonTag('themeBtn'), /tb-sec/, 'the theme panel re-anchors to this button - stays visible');
  });

  test('#moreBtn is the last button of the right cluster and is labelled', () => {
    const more = buttonTag('moreBtn');
    assert.match(more, /tb-more/);
    assert.match(more, /aria-label="More actions"/);
    for (const id of SEC_IDS) {
      assert.ok(HTML.indexOf('id="moreBtn"') > HTML.indexOf(`id="${id}"`), `#moreBtn must come after #${id}`);
    }
  });

  test('the more menu re-clicks the original buttons so handlers stay in one place', () => {
    assert.match(APP, /TOPBAR_MORE_ITEMS/, 'the item list exists');
    for (const id of SEC_IDS) {
      assert.match(APP, new RegExp(`'${id}'`), `TOPBAR_MORE_ITEMS must include ${id}`);
    }
    const at = APP.indexOf("$('#moreBtn')?.addEventListener('click'");
    assert.notEqual(at, -1, 'the moreBtn wiring exists');
    const handler = APP.slice(at, APP.indexOf('});', at) + 3);
    assert.match(handler, /b\.click\(\)/, 'items activate the original buttons, not copies');
    assert.match(handler, /'topbar-more'/, 'the popup toggles against the more button');
  });

  test('tb-sec hides and tb-more shows only below 1100px', () => {
    const base = CSS.match(/\.tb-more\{[^}]*\}/);
    assert.ok(base, 'the base .tb-more rule exists');
    assert.match(base[0], /display:\s*none/, 'the overflow button is hidden on wide bars');
    const at = CSS.indexOf('@media (max-width:1100px)');
    assert.ok(at >= 0, 'the <=1100px block must exist');
    const block = CSS.slice(at, at + 200);
    assert.match(block, /\.topbar \.tb-sec\{display:none\}/);
    assert.match(block, /\.topbar \.tb-more\{display:grid\}/);
  });
});

describe('the classic floating topbar cannot clip the pills again', () => {
  test('it wraps instead of nowrap', () => {
    const rule = CSS.match(/body\.ui-classic \.topbar\{[^}]*\}/);
    assert.ok(rule, 'the classic topbar rule exists');
    assert.match(rule[0], /flex-wrap:\s*wrap/, 'the single-row nowrap bar pushed the token and save pills past the window');
    assert.doesNotMatch(rule[0], /flex-wrap:\s*nowrap/);
  });
});

describe('applyUiLayout keeps the phone sidebar collapsed', () => {
  test('restoreShell drops side-open but honours the 720px phone rule', () => {
    const at = APP.indexOf("side.classList.remove('side-open');");
    assert.notEqual(at, -1, 'restoreShell keeps its phone guard where it removes side-open');
    const chunk = APP.slice(at, at + 400);
    assert.match(chunk, /matchMedia\('\(max-width: 720px\)'\)/, 'the phone breakpoint is consulted before re-adding .collapsed');
    assert.match(chunk, /if\(window\.matchMedia\('\(max-width: 720px\)'\)\.matches\)\{ side\.classList\.add\('collapsed'\); \} else \{ side\.classList\.remove\('collapsed'\); \}/,
      'phones keep the sidebar collapsed, wider windows open it');
  });
});
