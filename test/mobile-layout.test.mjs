// Mobile phones are a first-class target: the app must stay usable at 320-430px
// wide, where the desktop sidebars, fixed-width panels and popovers do not fit.
// These assertions cover the layout fixes that keep every control reachable.
// They read the real source, like the other CSS/JS contract tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

describe('notes editor on phones', () => {
  test('the sticky note is clamped inside the viewport instead of opening at a negative left', () => {
    // It is 340px wide and used to open at "stage centre - 240", which is
    // negative on a ~360px phone: the toolbar and the start of every line were
    // clipped. It must be appended first so it can be measured, then clamped.
    const appendAt = APP.indexOf("popup.style.visibility='hidden';");
    assert.notEqual(appendAt, -1, 'the popup must be hidden before its first paint');
    const append = APP.indexOf('document.body.appendChild(popup);', appendAt);
    assert.notEqual(append, -1);
    const fill = APP.indexOf('editor.innerHTML = sanitizeNotes', append);
    assert.notEqual(fill, -1, 'the saved note must be put in the editor');
    const measure = APP.indexOf('popup.getBoundingClientRect()', append);
    assert.notEqual(measure, -1, 'the real box is measured after appending');
    assert.ok(fill < measure,
      'a long note must be filled in before measuring, or the clamp uses the empty editor height and still overflows');
    const clamp = APP.slice(measure, measure + 600);
    assert.match(clamp, /vw - pr\.width\/z - margin/, 'the right edge is capped to the viewport');
    assert.match(clamp, /vh - pr\.height\/z - margin/, 'the bottom edge is capped to the viewport');
    assert.match(clamp, /Math\.max\(margin, Math\.min\(left,/, 'the left edge never goes below the margin');
    assert.match(clamp, /Math\.max\(margin, Math\.min\(top,/, 'the top edge never goes below the margin');
  });

  test('the note becomes a shrinking column so its Save row cannot slide off-screen', () => {
    const rules = [...CSS.matchAll(/\.notes-popup\{([^}]*)\}/g)].map(m => m[1]);
    const phone = rules.find(r => /display:flex/.test(r));
    assert.ok(phone, 'the phone notes-popup rule must exist');
    assert.match(phone, /flex-direction:column/);
    assert.match(phone, /max-height:calc\(100dvh \/ var\(--ui-zoom, 1\) - 16px\)/,
      'the cap is in dvh divided by the UI zoom, like every other full-height box');
    const editor = CSS.match(/\.notes-popup \.np-editor\{[^}]*flex:1 1 auto[^}]*\}/);
    assert.ok(editor, 'the editor must be the flexible child');
    assert.match(editor[0], /min-height:0/, 'min-height:0 is what lets it actually shrink');
    assert.match(editor[0], /max-height:none/, 'the old 50vh cap must be lifted on phones');
  });
});

describe('desktop-width panels on phones', () => {
  const rule = (selector) => {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'g');
    return [...CSS.matchAll(re)].map(m => m[1]);
  };

  test('history and diff panels span the phone width instead of hanging off it', () => {
    const rules = rule('.hist-panel, .diff-panel');
    const phone = rules.find(r => /left:8px/.test(r));
    assert.ok(phone, 'the phone override must exist');
    assert.match(phone, /right:8px/);
    assert.match(phone, /width:auto/);
    assert.match(phone, /max-width:none/, 'the desktop width must be released');
  });

  test('the template popover, empty card and toast cap to the viewport', () => {
    const tpl = rule('.tpl-pop').find(r => /calc\(100vw - 16px\)/.test(r));
    assert.ok(tpl, 'the template popover must cap to the phone width');
    assert.match(tpl, /max-width:340px/);

    const empty = rule('.empty .e-card').find(r => /calc\(100vw - 32px\)/.test(r));
    assert.ok(empty, 'the blank-canvas card must cap to the phone width');

    const toast = rule('.toast').find(r => /max-width:calc\(100% - 24px\)/.test(r));
    assert.ok(toast, 'a long toast must wrap inside the stage, not run off it');
  });

  test('the bulk bar and preview banner wrap instead of clipping their outer buttons', () => {
    const bulk = rule('.bulk-bar').find(r => /flex-wrap:wrap/.test(r));
    assert.ok(bulk, 'the multi-select bar must wrap on a phone');
    assert.match(bulk, /max-width:calc\(100vw - 16px\)/);

    const banner = rule('.hist-banner').find(r => /flex-wrap:wrap/.test(r));
    assert.ok(banner, 'the version-preview banner must wrap on a phone');
    assert.match(banner, /max-width:calc\(100vw - 16px\)/);
  });

  test('the build-prompt panel may shrink below its desktop min-width', () => {
    const bp = rule('.bp-panel').find(r => /min-width:0/.test(r));
    assert.ok(bp, 'a 300px min-width overflows a 320px screen once its margins are counted');
  });

  test('the markdown pane stays a usable width in dock, minimal and split', () => {
    const pane = CSS.match(/body\.ui-dock #mdPane,\s*body\.ui-dock\.md-mode #mdPane,\s*body\.ui-minimal #mdPane,\s*body\.ui-minimal\.md-mode #mdPane,\s*body\.ui-split #mdPane\{([^}]*)\}/);
    assert.ok(pane, 'the phone override must cover every layout that pins the pane at 40vw');
    assert.match(pane[1], /width:min\(94vw,560px\)/,
      '40vw is about 144px on a phone, below the pane\'s own 240px resize minimum');
  });

  test('split mode on a phone can be dismissed', () => {
    assert.match(CSS, /body\.ui-split #mdToggle\{display:grid\}/,
      'split hides the toolbar toggle on desktop; a phone needs it back');
    assert.match(CSS, /body\.ui-split #mdPane \.md-close\{display:inline-block\}/,
      'and the close button, or the 94vw overlay has no way out');
  });

  test('the rail replace field caps to the phone width', () => {
    const rail = CSS.match(/body\.ui-rail \.topbar \.search-wrap\.open\.replace-mode\{[^}]*\}/g) || [];
    assert.ok(rail.some(r => /width:min\(86vw,330px\)/.test(r)),
      'the desktop 420px field beat the phone cap by specificity');
  });
});

describe('the core phone shell is still in place', () => {
  test('the sidebar is an off-canvas overlay that slides fully away', () => {
    const side = [...CSS.matchAll(/\.side\{([^}]*)\}/g)].map(m => m[1])
      .find(r => /position:fixed/.test(r) && /translateX\(0\)/.test(r));
    assert.ok(side, 'the phone sidebar overlay rule must exist');
    const collapsed = [...CSS.matchAll(/\.side\.collapsed\{([^}]*)\}/g)].map(m => m[1])
      .find(r => /translateX\(-100%\)/.test(r));
    assert.ok(collapsed, 'collapsed means fully off-screen, not a squeezed column');
    assert.match(collapsed, /width:min\(280px, 86vw\) !important/,
      'the width must be kept so the slide transition works');
  });

  test('the phone topbar uses bigger tap targets and hides the tab strip', () => {
    assert.match(CSS, /\.tb\{width:38px; height:38px; font-size:18px\}/,
      'toolbar buttons must be at least ~38px on a phone');
    assert.match(CSS, /#tabStrip, #tabsBtn\{display:none\}/,
      'the tabbed workspace is a desktop feature');
  });
});

// A rule that only applies on phones must sit inside a max-width:720px block.
// Comments in these blocks quote rules, but always with balanced braces, so a
// brace count from the @media to the rule tells whether it is still inside.
const inPhoneBlock = (rule) => {
  const at = CSS.indexOf(rule);
  assert.notEqual(at, -1, 'rule not found: ' + rule);
  const media = CSS.lastIndexOf('@media', at);
  assert.match(CSS.slice(media, CSS.indexOf('{', media)), /max-width:\s?720px/, rule + ' must be phone-only');
  const between = CSS.slice(media, at);
  const depth = (between.match(/\{/g) || []).length - (between.match(/\}/g) || []).length;
  assert.equal(depth, 1, rule + ' must sit directly inside the phone block');
};

describe('every interface layout on a phone', () => {
  test('rail and zen keep the collapsed sidebar full width, like classic', () => {
    // The desktop shells collapse to `width:0 !important`, which beat the phone
    // overlay width; the overlay forces tabs, pane and footer back on, so they
    // spilled out of a 0px sidebar over the map title and down the left edge.
    inPhoneBlock('body.ui-classic .side.collapsed{width:min(280px, 86vw) !important}');
    inPhoneBlock('body.ui-rail .side.collapsed{width:min(280px, 86vw) !important}');
    inPhoneBlock('body.ui-zen .side.collapsed{width:min(320px, 86vw) !important}');
  });

  test('the zen strip is always shown without hover, except in focus mode', () => {
    // It was revealed only by a mouse near the top edge, so on a touch screen
    // the sidebar toggle, search, theme and More could never be reached.
    const hoverNone = CSS.match(/@media \(hover:none\)\{([\s\S]*?)\n\}/);
    assert.ok(hoverNone, 'touch screens of any width need the strip shown');
    assert.match(hoverNone[1], /body\.ui-zen:not\(\.focus-mode\) \.topbar\{[^}]*opacity:1[^}]*pointer-events:auto/);
    assert.match(hoverNone[1], /body\.ui-zen #zenPin\{display:none\}/, 'nothing is left for the pin to toggle');
    inPhoneBlock('body.ui-zen:not(.focus-mode) .topbar{opacity:1;transform:translateY(0);pointer-events:auto}');
    assert.match(CSS, /body\.ui-zen\.focus-mode \.topbar\{opacity:0/, 'focus mode still hides it');
  });

  test('the zen strip may wrap once the overflow menu is not enough', () => {
    assert.match(CSS, /body\.ui-zen \.topbar\.tb-wrap\{flex-wrap:wrap\}/,
      'a nowrap strip clipped search, theme and More past the right edge of a phone');
    inPhoneBlock('body.ui-zen .save-pill{top:auto;bottom:14px;left:14px;right:auto}');
  });

  test('the dock row fits a 320px phone', () => {
    inPhoneBlock('body.ui-dock #zoomSlider{display:none}');
    inPhoneBlock('body.ui-dock .statusbar{gap:6px;padding:6px 8px}');
  });

  test('the node toolbar groups wrap inside the bar', () => {
    inPhoneBlock('.nodebar .nb-group{flex-wrap:wrap; min-width:0}');
  });

  test('the open search field leaves room to type', () => {
    inPhoneBlock('.search-wrap.open{width:min(62vw, 230px)}');
    assert.doesNotMatch(CSS, /\.search-wrap\.open\{width:140px\}/,
      '140px shared with two toggles left about four letters of the query visible');
  });
});

describe('the sidebar toggle on a phone', () => {
  // A minimal DOM: elements with a class name, children, and the handful of
  // methods placeSideToggle() and sideToggleGroup() use. Fresh per test.
  const fixture = (bodyClasses, phone) => {
    const has = (e, sel) => e.className.split(' ').includes(sel.slice(1));
    const detach = (c) => {
      const p = c.parentElement;
      if (p) { p.children.splice(p.children.indexOf(c), 1); c.parentElement = null; }
    };
    const el = (className = '') => ({
      className, children: [], parentElement: null,
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { detach(c); c.parentElement = this; this.children.push(c); return c; },
      insertBefore(c, ref) {
        detach(c); c.parentElement = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        this.children.splice(i < 0 ? this.children.length : i, 0, c);
        return c;
      },
      remove() { detach(this); },
      querySelector(sel) {
        for (const k of this.children) { if (has(k, sel)) return k; const d = k.querySelector(sel); if (d) return d; }
        return null;
      },
      closest(sel) { for (let e = this; e; e = e.parentElement) if (has(e, sel)) return e; return null; },
    });
    const root = el('app');
    const topbar = root.appendChild(el('topbar'));
    const title = topbar.appendChild(el('title-edit'));
    const brand = root.appendChild(el('side')).appendChild(el('brand'));
    brand.appendChild(el('tb'));                       // #newMap
    const toggle = brand.appendChild(el('tb'));        // #toggleSide
    const state = { phone };
    const document = {
      body: { classList: { contains: (c) => bodyClasses.includes(c) } },
      querySelector: (sel) => root.querySelector(sel),
      createElement: () => el(),
    };
    const window = { matchMedia: (q) => ({ matches: q === '(max-width: 720px)' && state.phone }) };
    const $ = (sel) => (sel === '#toggleSide' ? toggle : null);
    const fns = loadFns(['placeSideToggle', 'sideToggleGroup'], { document, window, $ });
    return { ...fns, state, topbar, title, brand, toggle };
  };

  test('modern, split and outline move the toggle into the bar on a phone', () => {
    // The modern shell keeps it in the brand row, which is hidden with the
    // collapsed phone sidebar: there was no way to open Maps or Templates.
    for (const layout of [[], ['ui-split'], ['ui-outline', 'outline-open']]) {
      const t = fixture(layout, true);
      t.placeSideToggle();
      const grp = t.topbar.firstChild;
      assert.ok(grp.className.includes('tb-orphan'), layout + ': the group leads the bar');
      assert.equal(t.toggle.parentElement, grp, layout + ': the toggle is in it');
      assert.equal(t.topbar.children[1], t.title, 'the title follows the toggle, as in classic');
    }
  });

  test('a second call does not add a second group', () => {
    const t = fixture([], true);
    t.placeSideToggle();
    t.placeSideToggle();
    assert.equal(t.topbar.children.filter(c => c.className.includes('tb-orphan')).length, 1);
  });

  test('widening past the breakpoint sends the toggle home and drops the group', () => {
    const t = fixture([], true);
    t.placeSideToggle();
    t.state.phone = false;
    t.placeSideToggle();
    assert.equal(t.toggle.parentElement, t.brand);
    assert.equal(t.brand.children.at(-1), t.toggle, 'last in the brand row, where restoreShell leaves it');
    assert.equal(t.topbar.querySelector('.tb-orphan'), null);
  });

  test('a desktop window leaves the brand row alone', () => {
    const t = fixture([], false);
    t.placeSideToggle();
    assert.equal(t.toggle.parentElement, t.brand);
    assert.equal(t.topbar.firstChild, t.title);
  });

  test('the shells that place the toggle themselves are left alone', () => {
    for (const shell of ['ui-classic', 'ui-rail', 'ui-zen', 'ui-dock', 'ui-minimal']) {
      const t = fixture([shell], true);
      t.placeSideToggle();
      assert.equal(t.toggle.parentElement, t.brand, shell + ' must not be rearranged here');
    }
  });

  test('applyUiLayout places it, and a breakpoint change places it again', () => {
    const at = APP.indexOf('function applyUiLayout(');
    const body = APP.slice(at, APP.indexOf('\nfunction ', at + 1));
    assert.match(body, /placeSideToggle\(\);[^\n]*\r?\n\s*observeTopbar\(\);/,
      'placed before the overflow menu is re-decided, since it adds to the bar');
    assert.match(APP, /matchMedia\('\(max-width: 720px\)'\)\.addEventListener\('change', \(\)=>\{ placeSideToggle\(\); observeTopbar\(\); \}\)/,
      'a phone turned to landscape crosses the breakpoint without a layout switch');
  });
});
