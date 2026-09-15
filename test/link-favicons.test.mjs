// Link favicons come from DuckDuckGo's icon service, which learns the hostname
// of every link in a map. That was the one thing in the app that told a third
// party about map content, with no way to turn it off (ToDo #3). It is now a
// per-browser preference that starts OFF; both fetch sites ask the same flag,
// and the flag is part of every node's render signature so toggling it
// actually rebuilds the nodes instead of reusing elements with stale icons.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

const load = store => loadFns(['linkFaviconsEnabled', 'setLinkFavicons'], {
  LINK_FAVICONS_KEY: 'mindspark:linkFavicons',
  localStorage: { getItem: k => { if (store === 'throw') throw new Error('blocked'); return store[k] ?? null; }, setItem: (k, v) => { store[k] = v; } },
  map: null, render: () => {},
});

describe('link favicons preference', () => {
  test('off unless the user turned it on; blocked storage means off', () => {
    assert.equal(load({}).linkFaviconsEnabled(), false);
    assert.equal(load({ 'mindspark:linkFavicons': '1' }).linkFaviconsEnabled(), true);
    assert.equal(load({ 'mindspark:linkFavicons': '0' }).linkFaviconsEnabled(), false);
    assert.equal(load({ 'mindspark:linkFavicons': 'yes' }).linkFaviconsEnabled(), false, 'only the exact "1" enables it');
    assert.equal(load('throw').linkFaviconsEnabled(), false);
  });

  test('setLinkFavicons persists as "1" / "0"', () => {
    const store = {};
    const { setLinkFavicons } = load(store);
    setLinkFavicons(true); assert.equal(store['mindspark:linkFavicons'], '1');
    setLinkFavicons(false); assert.equal(store['mindspark:linkFavicons'], '0');
  });

  test('both places that would fetch an icon ask the flag first', () => {
    assert.match(extractFunction('appendTextWithLinks'), /if\(_host && linkFaviconsEnabled\(\)\)\{/);
    assert.match(extractFunction('exportPNG'), /if\(linkFaviconsEnabled\(\)\) await Promise\.all\(\[\.\.\.hosts\]/);
    // Exactly those two fetch sites (the Preferences label also names the host, without fetching).
    assert.equal((APP.match(/icons\.duckduckgo\.com\/ip3\//g) || []).length, 2);
  });

  test('the flag is in the render signature, so a toggle rebuilds nodes', () => {
    assert.match(extractFunction('render'), /linkFaviconsEnabled\(\)\?'fav':'nofav'/);
  });

  test('the Preferences control names the host and goes through setLinkFavicons', () => {
    const at = APP.indexOf('function showPreferences(');
    const body = APP.slice(at, at + APP.slice(at).search(/\r?\n\}\r?\n/));
    assert.match(body, /row\(ap, 'Link favicons', check\('[^']*duckduckgo\.com[^']*', linkFaviconsEnabled\(\), setLinkFavicons\)\)/);
  });
});
