// Narrow windows used to lose the right end of the top bar. The floating
// shells (classic, mirror) were single-row nowrap pills, so at ~768px the
// token counter was shoved ~44px past the edge and the save pill ~112px
// past it; at 375px even the search/theme/more cluster ran off the right
// side. The modern shell wrapped but its status-bar pills hide by design on
// phones, and applyUiLayout re-added the sidebar on phones, covering the
// whole bar. Three fixes, pinned here:
//   1. When the bar overflows, the least-used actions collapse into #moreBtn
//      (.tb-more) and the .tb-sec buttons hide (search and theme stay
//      visible: the search overlay anchors to #searchBtn, the theme panel to
//      #themeBtn). This is measured by fitTopbar(), not a viewport media
//      query: a max-width:1100px rule hid the buttons on a landscape phone
//      whose bar had room, and missed a 13 inch laptop that did not.
//   2. The classic floating topbar stays nowrap (so the save pill keeps its
//      place on the first row, as upstream) and wraps only as a last resort
//      (.tb-wrap) when even the overflow menu leaves it too wide.
//   3. applyUiLayout's restoreShell keeps the phone-only collapsed sidebar.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns } from './helpers/load-app-fns.mjs';
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

  // The whole click handler, up to the next top-level statement.
  function moreHandler() {
    const at = APP.indexOf("$('#moreBtn')?.addEventListener('click'");
    return APP.slice(at, APP.indexOf('\n});', at) + 4);
  }

  test('the menu lists only buttons the full bar would show', () => {
    // #outlineBtn is hidden outside the outline layout and #tabsBtn on phones;
    // the menu used to offer them anyway.
    const h = moreHandler();
    assert.match(h, /TOPBAR_MORE_ITEMS\.filter\(\(\[id\]\)=>document\.getElementById\(id\)\?\.offsetWidth>0\)/);
    assert.match(h, /classList\.remove\('tb-compact'\)[\s\S]*offsetWidth[\s\S]*classList\.add\('tb-compact'\)/,
      'visibility is read with the bar briefly un-compacted, then restored');
  });

  test('the more menu arms through the shared armRowPop with its trigger', () => {
    assert.match(moreHandler(), /armRowPop\(pop, trigger\)/);
  });
});

describe('row menus close on a second click of their trigger', () => {
  // Otherwise the trigger's mousedown closes the menu as "outside" and its
  // click reopens it, so the toggle-off branch in every menu was dead code.
  test('every row menu arms through armRowPop, none inline its own outside handler', () => {
    const inline = APP.match(/_rowPopOut=\(/g) || [];
    assert.equal(inline.length, 1, 'only armRowPop builds the outside-click handler');
    for (const fn of ['openRowMenu', 'openSharedByMeRowMenu', 'openSharedRowMenu']) {
      const at = APP.indexOf(`function ${fn}(`);
      assert.notEqual(at, -1, `${fn} exists`);
      const body = APP.slice(at, APP.indexOf('\nfunction ', at + 1));
      assert.match(body, /armRowPop\(pop, btn\)/, `${fn} arms through the shared helper`);
    }
  });

  test('a mousedown on the trigger leaves the menu open, one outside closes it', async () => {
    const listeners = {};
    const fakeTarget = { addEventListener: (t, fn) => { listeners[t] = fn; }, removeEventListener: (t) => { delete listeners[t]; } };
    const { armRowPop } = loadFns(['armRowPop', 'closeRowMenu'],
      { _rowPop: null, _rowPopOut: null, document: fakeTarget, window: fakeTarget });
    let removed = 0;
    const inPop = {}, onTrigger = {}, elsewhere = {};
    const pop = { contains: (t) => t === inPop, remove: () => { removed++; } };
    const trigger = { contains: (t) => t === onTrigger };
    armRowPop(pop, trigger);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(typeof listeners.mousedown, 'function', 'the outside handler attaches on the next tick');
    listeners.mousedown({ type: 'mousedown', target: onTrigger });
    assert.equal(removed, 0, 'the trigger is not outside: its click handles the toggle');
    listeners.mousedown({ type: 'mousedown', target: inPop });
    assert.equal(removed, 0, 'a press inside the menu keeps it open');
    listeners.mousedown({ type: 'mousedown', target: elsewhere });
    assert.equal(removed, 1, 'a press anywhere else closes it');
  });

  test('tb-sec hides and tb-more shows only while the bar is compact', () => {
    const base = CSS.match(/\.tb-more\{[^}]*\}/);
    assert.ok(base, 'the base .tb-more rule exists');
    assert.match(base[0], /display:\s*none/, 'the overflow button is hidden on wide bars');
    assert.match(CSS, /\.topbar\.tb-compact \.tb-sec\{display:none\}/);
    assert.match(CSS, /\.topbar\.tb-compact \.tb-more\{display:grid\}/);
    assert.doesNotMatch(CSS, /@media \(max-width:1100px\)\{\s*\.topbar \.tb-sec/,
      'a viewport breakpoint cannot know how much of the window the bar actually gets');
  });

  test('applyUiLayout re-fits the bar after moving pills into it', () => {
    const at = APP.indexOf('function applyUiLayout(');
    const end = APP.indexOf('\nfunction ', at + 1);
    assert.match(APP.slice(at, end), /observeTopbar\(\)/);
  });
});

describe('topbarOverflows', () => {
  const { topbarOverflows } = loadFns(['topbarOverflows']);
  const kid = (top, h, w = 36) => ({ offsetTop: top, offsetHeight: h, offsetWidth: w });
  const bar = (o) => ({ scrollWidth: 800, clientWidth: 800, scrollHeight: 44, clientHeight: 44, children: [], ...o });

  test('a single row that fits does not overflow, whatever the children heights', () => {
    // A 26px separator centred beside 34px buttons, and the zero-height spacer.
    const b = bar({ children: [kid(0, 34), kid(4, 26, 1), kid(17, 0, 200), kid(0, 34)] });
    assert.equal(topbarOverflows(b, false), false);
  });

  test('a nowrap bar overflows when content runs past its edge', () => {
    assert.equal(topbarOverflows(bar({ scrollWidth: 900, children: [kid(0, 34)] }), false), true);
  });

  test('a wrapping bar overflows when a child drops to a second line', () => {
    const b = bar({ children: [kid(0, 34), kid(4, 26, 1), kid(38, 34)] });
    assert.equal(topbarOverflows(b, false), true);
  });

  test('hidden children do not count as wrapped', () => {
    const b = bar({ children: [kid(0, 34), kid(60, 0, 0)] });
    assert.equal(topbarOverflows(b, false), false);
  });

  test('the rail column overflows downwards only', () => {
    assert.equal(topbarOverflows(bar({ scrollHeight: 700, clientHeight: 600 }), true), true);
    assert.equal(topbarOverflows(bar({ scrollWidth: 900 }), true), false);
  });
});

describe('the classic floating topbar keeps its pills on screen', () => {
  test('it is nowrap, so the save pill stays on the first row', () => {
    const rule = CSS.match(/body\.ui-classic \.topbar\{[^}]*\}/);
    assert.ok(rule, 'the classic topbar rule exists');
    assert.match(rule[0], /flex-wrap:\s*nowrap/, 'wrapping by default moved the save pill to a second row on a 13 inch laptop');
  });

  test('it wraps only when fitTopbar marks it .tb-wrap', () => {
    assert.match(CSS, /body\.ui-classic \.topbar\.tb-wrap\{flex-wrap:wrap\}/,
      'on a portrait phone the single-row bar pushed the token and save pills past the window');
    const at = APP.indexOf('function fitTopbar(');
    const body = APP.slice(at, APP.indexOf('\nfunction ', at + 1));
    assert.match(body, /tb-compact[\s\S]*tb-wrap/, 'wrapping is tried only after the overflow menu');
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
