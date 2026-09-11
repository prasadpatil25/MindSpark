// The Build Prompt panel is a fixed, draggable, resizable card anchored to the
// top right. "Run with API" reveals a second section (provider, model, key,
// Send) and marks the panel .bp-expanded so it can grow to show it. A previous
// fix gave that state `height:100vh`, which filled the whole screen and, with
// the panel sitting at top:64px, pushed its bottom 64px past the window edge
// so the Send row was clipped. These assertions pin the shape of the fix.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Declaration block of the first rule whose selector list is exactly `sel`. */
function rule(sel) {
  const m = CSS.match(new RegExp('(?:^|[\\r\\n}])\\s*' + escapeRe(sel) + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, 'rule not found: ' + sel);
  return m[1];
}
/** Value of one property inside a declaration block, or null. */
function prop(block, name) {
  const m = block.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}

describe('build prompt panel: Run with API', () => {
  const base = rule('.bp-panel');
  const expanded = rule('.bp-panel.bp-expanded');

  test('the expanded panel does not get a fixed height', () => {
    assert.equal(prop(expanded, 'height'), null, 'a fixed height fills the screen regardless of content');
  });

  test('the expanded panel is bounded to the window below its own top anchor', () => {
    const top = parseInt(prop(base, 'top'), 10);
    const right = parseInt(prop(base, 'right'), 10);
    assert.ok(top > 0 && right > 0, 'the panel is anchored top right');
    const max = prop(expanded, 'max-height');
    assert.ok(max, 'expanded state must cap its height');
    assert.doesNotMatch(max, /^100vh$/, '100vh from a 64px top anchor overflows the window bottom');
    // The cap has to leave room for the top offset plus the same margin the
    // panel keeps on the right, or the bottom of the card is off screen.
    const m = max.match(/^calc\(100vh\s*-\s*(\d+)px\)$/);
    assert.ok(m, 'expected calc(100vh - <n>px), got ' + max);
    assert.equal(Number(m[1]), top + right);
  });

  test('opening the section never resizes the prompt textarea', () => {
    // A shrunk textarea grows an inner scrollbar and its text re-wraps
    // narrower, which reads as the box changing width. So it must not take
    // part in flex shrinking, and the expanded state must not override it.
    assert.equal(prop(rule('.bp-text'), 'flex-shrink'), '0');
    assert.doesNotMatch(CSS, /\.bp-panel\.bp-expanded\s+\.bp-text\s*\{/, 'expanded state must leave .bp-text alone');
    // The run section is what absorbs a short window instead.
    const run = rule('.bp-run');
    assert.equal(prop(run, 'min-height'), '0');
    assert.equal(prop(run, 'overflow-y'), 'auto');
  });

  test('opening the section clears a manual-resize height and toggles the class', () => {
    const at = APP.indexOf("$$('.bp-toggle').onclick");
    assert.notEqual(at, -1, 'toggle handler not found');
    const handler = APP.slice(at, APP.indexOf('};', at) + 2);
    // resize:both leaves an inline height behind; without clearing it the panel
    // cannot grow and the new rows land in a scrolling strip.
    assert.match(handler, /if\(show\)\s*panel\.style\.height=''/);
    assert.match(handler, /classList\.toggle\('bp-expanded',\s*show\)/);
    assert.doesNotMatch(handler, /style\.width/, 'width the user chose is kept');
  });
});

// "Add as child nodes" is one of the ways the panel closes, and it has to
// leave through closePanel(): a bare panel.remove() kept _bpPanel pointing at
// a detached element and never returned focus to where it came from.
describe('build prompt panel: closing after Add', () => {
  test('the Add handler goes through closePanel()', () => {
    const at = APP.indexOf("add.textContent='Add as child nodes'");
    assert.notEqual(at, -1);
    const handler = APP.slice(at, APP.indexOf('\n', at + 60));
    assert.match(handler, /add\.onclick=\(\)=>\{[^\n]*closePanel\(\)/);
    assert.doesNotMatch(handler, /panel\.remove\(\)/);
  });
});
