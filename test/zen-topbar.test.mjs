import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');
const appJs = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

// Zen write mode floats one centered pill (.topbar) over the canvas and
// appends #zenPin as its LAST child. The pill caps itself at 92vw (98vw while
// search is open). It must stay a SINGLE row - never wrap - and reclaim
// space by hiding low-priority actions while search is open, so the token
// counter and pin stay on the first row instead of spilling or wrapping.
test('zen topbar must stay single-row (no wrapping) and hide overflow', () => {
  const rule = css.match(/body\.ui-zen \.topbar\{[^}]*\}/);
  assert.ok(rule, 'the floating zen topbar rule must exist');
  assert.match(rule[0], /flex-wrap:\s*nowrap/,
    'zen pill must be nowrap - wrapping pushes token/pin onto a second row');
  assert.doesNotMatch(rule[0], /flex-wrap:\s*wrap/,
    'wrap creates a second row when search opens; hide actions instead');
  assert.match(rule[0], /overflow:\s*hidden/,
    'nowrap bar should clip rather than spill when space is tight');
});

// On phones (<=720px) the zen topbar becomes a full-width strip via
// left+right insets. The desktop show/hide transforms include
// translateX(-50%) (centering), which shifted that strip half its own width
// off-screen - half the toolbar was unreachable. The strip must translate
// vertically only.
test('mobile zen topbar strip must not keep the horizontal centering transform', () => {
  // The file has several max-width:720px blocks; the zen overrides live in
  // the layout-breakpoint one near the end of the sheet.
  const blocks = [...css.matchAll(/@media \(max-width:\s?720px\)\{[\s\S]*?\n\}/g)].map(m => m[0]);
  const media = blocks.find(b => b.includes('body.ui-zen .topbar'));
  assert.ok(media, 'the <=720px block holding the zen topbar override must exist');
  const base = media.match(/body\.ui-zen \.topbar\{[^}]*\}/);
  assert.ok(base, 'the mobile zen topbar override must exist');
  assert.match(base[0], /left:\s*10px/, 'strip keeps the side insets');
  assert.match(base[0], /right:\s*10px/, 'strip keeps the side insets');
  assert.doesNotMatch(base[0], /translateX\(/,
    'an inset-stretched strip must never be shifted horizontally');
  // The shown states re-appear inside the query so they beat the desktop
  // translateX(-50%) rules purely by source order.
  const shown = media.match(/body\.ui-zen\.(?:zen-chrome|zen-pinned) \.topbar\{[^}]*\}/);
  assert.ok(shown, 'mobile shown-state transform override must exist');
  assert.doesNotMatch(shown[0], /translateX\(/,
    'shown strip must slide in vertically only');
});

// Even with the wider 98vw cap, the 230px find field can push the token
// counter and pin off the single row at ~1024px (pin clipped by ~2px) and at
// ~960px (both clipped). While that field is open the least-used actions
// must step aside so the single-row bar reclaims space. Tabbed workspace (▭)
// is the primary reclaim per spec; Donate (♥) is also low-priority while
// searching and covers the remaining overflow. (Present was in this rule
// until its toolbar button was removed.)
test('zen topbar hides tabs (+ donate) toggles while the find field is open', () => {
  const rule = css.match(
    /body\.ui-zen \.topbar:has\(\.search-wrap\.open\) #tabsBtn,[\s\S]*?#donateBtn\{[^}]*\}/);
  assert.ok(rule, 'the search-open space-reclaim rule must exist (tabs + donate)');
  assert.match(rule[0], /display:\s*none/,
    'tabs/donate must be display:none until search closes');
  assert.match(rule[0], /#tabsBtn/,
    'tabsBtn must be in the hide rule');
  const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/#presentBtn/.test(css) && !html.includes('id="presentBtn"') && !appJs.includes('#presentBtn'),
    'the present button is gone from the bar, the styles and the wiring');
});

// Narrow windows (≤1024) still clip even after the three above; reclaim one
// more only there so wide screens keep the full bar.
test('zen topbar reclaims varsBtn on narrow windows while searching', () => {
  const q = css.match(/@media \(max-width:1024px\)\{[\s\S]*?#varsBtn\{[^}]*display:\s*none[^}]*\}/);
  assert.ok(q, '≤1024px search-open must also hide #varsBtn');
  assert.match(q[0], /body\.ui-zen \.topbar:has\(\.search-wrap\.open\) #varsBtn/,
    'narrow reclaim must be scoped to zen search-open');
});

// Pin toolbar button is zen-only - it must not leak into classic/rail/dock
// etc. JS removes it on every non-zen applyUiLayout, and CSS hides it as a
// safety net even if the DOM leaks.
test('pin toolbar button is zen-only', () => {
  assert.match(css, /body:not\(\.ui-zen\) #zenPin\s*\{[^}]*display:\s*none/,
    'CSS must hide #zenPin outside zen as a defensive rule');
  assert.match(appJs, /if\s*\(!zen\)\s*document\.getElementById\('zenPin'\)\?\.\s*remove\(\)/,
    'applyUiLayout must remove #zenPin when not in zen (classic/rail leak)');
  assert.match(appJs, /document\.getElementById\('zenPin'\)\?\.\s*remove\(\);\s*\/\/ pin toggle is zen-only/,
    'restoreShell must keep its zen-only pin removal');
  // Pinned state must show pin icon, not anchor (user request)
  assert.doesNotMatch(appJs, /pin\.textContent=on\?'.\\u2693'/,
    'pinned zenPin must not use anchor (⚓); it should stay as pin 📌');
  assert.match(appJs, /pin\.textContent='\\uD83D\\uDCCC'/,
    'zenPin should be pin 📌 for both states (.on background distinguishes)');
});

// When markdown pane is open in zen, the floating pill lives inside .stage
// (left:50% of the stage). A viewport cap (92vw) would bleed under the
// editor when --md-w grows, so it must also cap to the stage width - like
// VS Code/Obsidian zen where the title bar stays centred over the canvas.
test('zen + markdown pane caps toolbar to stage width', () => {
  const mdReady = css.match(/body\.ui-zen\.md-ready \.topbar\{[^}]*\}/);
  assert.ok(mdReady, 'zen md-ready topbar rule must exist');
  assert.match(mdReady[0], /max-width:\s*min\(92vw,\s*calc\(100% - 28px\)\)/,
    'md-ready pill must cap to min(92vw, stage width) so it shrinks when editor widens');
  const mdSearch = css.match(/body\.ui-zen\.md-ready \.topbar:has\(\.search-wrap\.open\)\{[^}]*\}/);
  assert.ok(mdSearch, 'zen md-ready search-open rule must exist');
  assert.match(mdSearch[0], /max-width:\s*min\(98vw,\s*calc\(100% - 16px\)\)/,
    'search-open md-ready pill must also cap to stage width');
});

// Theme panel is anchored to #themeBtn. Switching the app shell
// (modern ↔ rail ↔ zen ↔ dock …) reparents #themeBtn, so a still-open
// panel's fixed coordinates go stale. It must re-anchor - as Figma/VS Code
// popovers do - rather than staying stranded.
test('theme panel repositions after app-layout change', () => {
  assert.match(appJs, /else if\(cat==='ui'\)\s*\{[^}]*applyUiLayout\(id\);/,
    'ui category must still call applyUiLayout');
  assert.match(appJs, /repositionUi/,
    'ui handler must create a reposition helper after applyUiLayout');
  assert.match(appJs, /positionPopup\(themePanel, \$\('#themeBtn'\)/,
    'reposition must re-anchor themePanel to #themeBtn via positionPopup');
  assert.match(appJs, /_isRailNow \? \{side:'right'\} : \{align:'right'\}/,
    'reposition must recompute side vs align for rail (flyout) vs dropdown');
});

// Search fields should be small (12px) like the bottom hint “Tab child · Enter sibling”
test('search field font matches hint size', () => {
  const rule = css.match(/\.search-wrap input\{[^}]*\}/);
  assert.ok(rule, '.search-wrap input rule must exist');
  assert.match(rule[0], /font-size:\s*12px/,
    'search input (Find in nodes / Replace with) must be 12px like .hint (was 14px, overflowed 230px box)');
});
