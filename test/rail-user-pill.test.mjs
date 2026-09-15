// The signed-in pill (#userPill: avatar, username, sign-out) lives in the
// status bar, or in the floating toolbar for the layouts that hide the status
// bar (classic, zen). The side-toolbar layout hides the status bar too but
// never moved the pill, so it showed no username and no way to sign out. It
// now floats top-right of the canvas beside the save pill, in a group, and
// goes back to the status bar on every layout switch - the group is torn down
// AFTER the pills are moved out of it (removing it first deleted them).
// The look effect layer, separately, was appended after #viewport and painted
// OVER the map, which read as the whole map turning transparent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const applyUiLayout = extractFunction('applyUiLayout');

describe('user pill placement', () => {
  test('the pill stays in the status bar markup, where it always was', () => {
    const sb = HTML.slice(HTML.indexOf('class="statusbar"'), HTML.indexOf('id="overview"'));
    assert.match(sb, /<div class="user-pill" id="userPill"/);
    assert.ok(!HTML.includes('sideAccount'), 'no account row in the sidebar');
  });

  test('the layout reset moves the pills back to the status bar BEFORE tearing down the rail group', () => {
    const reset = applyUiLayout.indexOf("[$('#savePill'),$('#tokenTotal'),$('#userPill')].forEach(p=>{ if(p) sbRight.appendChild(p); });");
    const teardown = applyUiLayout.indexOf("document.querySelector('.rail-float')?.remove();");
    assert.ok(reset !== -1 && teardown !== -1, 'both statements exist');
    assert.ok(teardown > reset, 'removing the group first would delete the pills with it');
  });

  test('the side-toolbar layout floats the pill and the save pill together, top-right of the canvas', () => {
    const rail = applyUiLayout.slice(applyUiLayout.indexOf('}else if(rail){'), applyUiLayout.indexOf('}else if(zen){'));
    assert.match(rail, /fl\.className='rail-float'; stage\.appendChild\(fl\);/);
    assert.match(rail, /\[\$\('#userPill'\), \$\('#savePill'\)\]\.forEach\(p=>\{ if\(p\) fl\.appendChild\(p\); \}\);/);
    const rule = CSS.match(/body\.ui-rail \.rail-float\{[^}]*\}/);
    assert.ok(rule, 'rail-float rule');
    assert.match(rule[0], /position:absolute;top:14px;right:14px/);
    assert.match(rule[0], /display:flex/);
    assert.ok(!/body\.ui-rail \.save-pill\{position:absolute/.test(CSS), 'the save pill no longer positions itself; the group does');
  });

  test('classic and zen still put the pill in their floating toolbar', () => {
    assert.match(applyUiLayout, /\[\$\('#userPill'\),\$\('#tokenTotal'\),\$\('#savePill'\)\]\.forEach\(p=>\{ if\(p\) topbar\.appendChild\(p\); \}\);/, 'classic');
    assert.match(applyUiLayout, /\[\$\('#userPill'\),\$\('#tokenTotal'\)\]\.forEach\(p=>\{ if\(p\) topbar\.appendChild\(p\); \}\);/, 'zen');
  });
});

describe('look effect layer paints under the map', () => {
  test('the layer is inserted as the stage\'s first child and carries no positive z-index', () => {
    const sync = extractFunction('_syncLookFx');
    assert.match(sync, /stage\.insertBefore\(_fxEl, stage\.firstChild\)/);
    assert.doesNotMatch(sync, /stage\.appendChild\(_fxEl\)/);
    assert.match(CSS.match(/\.wave-layer\{[^}]*\}/)[0], /z-index:0/);
  });

  test('the side-toolbar rail is a solid column above the canvas', () => {
    const rule = CSS.match(/body\.ui-rail \.topbar\{[^}]*\}/)[0];
    assert.match(rule, /z-index:20/);
    assert.match(rule, /background:var\(--chrome\)/);
  });
});
