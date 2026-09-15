// A phone loaded in portrait and rotated to landscape: the narrow-viewport
// tap-to-close handler used to be installed once at load and to add
// .collapsed itself, over the inline width the expand path writes - leaving a
// blank ~200px column beside the canvas with only the rail's toggle showing.
// The handler now asks the media query per tap and closes through
// toggleSidePanel(), and every collapsed width is !important so no stale
// inline width can hold the column open whoever adds the class.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('sidebar collapse on touch', () => {
  test('the canvas tap handler is always attached, decides per tap, and closes through toggleSidePanel()', () => {
    const at = APP.indexOf("$('#stage').addEventListener('click'");
    assert.notEqual(at, -1);
    const handler = APP.slice(at, APP.indexOf('});', at) + 3);
    assert.match(handler, /if\(!window\.matchMedia\('\(max-width: 720px\)'\)\.matches\) return;/, 'the breakpoint is checked when the tap happens');
    assert.match(handler, /toggleSidePanel\(\)/, 'closing goes through the function that clears the inline width');
    assert.doesNotMatch(handler, /classList\.add\('collapsed'\)/, 'never adds the class directly');
    // and it is not wrapped in the load-time media check any more
    const before = APP.slice(Math.max(0, at - 200), at);
    assert.doesNotMatch(before, /if\(window\.matchMedia\('\(max-width: 720px\)'\)\.matches\)\{\s*$/);
  });

  test('every collapsed-sidebar width rule is !important', () => {
    const rules = [...CSS.matchAll(/([^{}]*\.side\.collapsed[^{}]*)\{([^}]*)\}/g)]
      .map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
      .filter(r => /(^|;)\s*width\s*:/.test(r.body) && !/\.side\.collapsed [.#]/.test(r.sel));   // the element itself, not its children
    assert.ok(rules.length >= 3, 'expected the base, the floating layouts and the touch overlay rules, found ' + rules.length);
    for (const r of rules) {
      const w = r.body.match(/(?:^|;)\s*width\s*:\s*([^;]+)/)[1];
      assert.match(w, /!important\s*$/, `"${r.sel}" width "${w.trim()}" must be !important`);
    }
  });
});
