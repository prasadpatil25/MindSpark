import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// renderOutline() rebuilds the outline dock tree. It diffs the produced HTML
// against the cached _olPrev and skips writing when unchanged. That cache
// must be invalidated whenever the pane is destroyed - otherwise switching
// away from the outline layout and back recreates an EMPTY pane whose content
// matches the stale cache, so nothing is ever written to it. An empty pane now
// also forces the write by itself, which covers a caller that forgets to reset.
function outlineStubs({ pane, prev, prevShape = '', labels = new Map(), sel = null, open = true, kids = [], text = 'Root', nodes = { r: { text } }, collapsed = new Set() }) {
  return {
    document: {
      getElementById: (id) => (id === 'outlinePane' ? pane : null),
      body: { classList: { contains: (c) => c === 'ui-outline' || (open && c === 'outline-open') } },
    },
    map: { nodes, rootId: 'r' },
    sel,
    hiddenSet: () => new Set(),
    childrenOf: () => kids,
    escapeHtml: (s) => s,
    nodeTextPlain: (s) => s,
    _olCollapsed: collapsed,
    _olPrev: prev,
    _olShape: prevShape,
    _olLabels: labels,
    _olSel: sel,
  };
}

function makePane() {
  let writes = 0;
  let html = '';
  const body = {
    scrollTop: 0,
    firstElementChild: null,
    get writes() { return writes; },
    get innerHTML() { return html; },
    set innerHTML(v) {
      writes++;
      html = v;
      body.firstElementChild = v ? { fake: true } : null;
    },
    querySelectorAll: () => [],
  };
  return {
    pane: { querySelector: (sel) => (sel === '.ol-body' ? body : null) },
    body,
    get writes() { return writes; },
  };
}

test('renderOutline fills a freshly created pane (cache empty)', () => {
  const { pane, body } = makePane();
  const { renderOutline } = loadFns(['renderOutline'], outlineStubs({ pane, prev: '' }));
  renderOutline();
  assert.ok(body.innerHTML.includes('Root'), 'fresh pane must contain the node label');
  assert.ok(body.innerHTML.includes('ol-tree'), 'fresh pane must contain the tree markup');
  assert.ok(body.innerHTML.includes('ol-twist ol-leaf'), 'leaf node must get the leaf twist');
});

test('renderOutline skips rewriting when the HTML is unchanged (cache works)', () => {
  const { pane, body } = makePane();
  const { renderOutline } = loadFns(['renderOutline'], outlineStubs({ pane, prev: '' }));
  renderOutline();
  const first = body.innerHTML;
  const writesAfterFirst = body.writes;
  renderOutline();                              // same map -> same html
  assert.equal(body.innerHTML, first, 'content must be identical');
  assert.equal(body.writes, writesAfterFirst, 'unchanged HTML must not rewrite the pane');
});

test('regression: a fresh pane with a stale _olPrev still renders', () => {
  // Simulates: render once, switch away (pane removed, _olPrev left behind),
  // switch back (pane recreated empty). Without the fix, the equal-content
  // guard skips the write and the outline is blank.
  const first = makePane();
  const { renderOutline: renderFirst } = loadFns(['renderOutline'], outlineStubs({ pane: first.pane, prev: '' }));
  renderFirst();
  const staleHtml = first.body.innerHTML;
  assert.ok(staleHtml.length > 0);

  const fresh = makePane();                     // the recreated empty pane
  const { renderOutline: renderFresh } = loadFns(['renderOutline'], outlineStubs({ pane: fresh.pane, prev: staleHtml }));
  renderFresh();
  assert.ok(fresh.body.innerHTML.includes('Root'), 'an empty pane must render even with a stale cache');
  assert.equal(fresh.writes, 1);
});

test('a same-shape edit patches labels instead of replacing the tree', () => {
  // Replacing 1500 rows to change one label was tens of ms on every edit.
  const fn = extractFunction('renderOutline');
  assert.match(fn, /const empty=!bodyEl\.firstElementChild;/);
  assert.match(fn, /if\(html===_olPrev && !empty\) return;/);
  assert.match(fn, /if\(shape!==_olShape \|\| empty\)\{/);
  assert.match(fn, /if\(_olLabels\.get\(id\)===label\) continue;/);
  assert.match(fn, /span\.textContent=label/);
});

test('a same-shape edit writes the label in place and leaves innerHTML alone', () => {
  // Behavioural guard for the source assertions above: the pane already holds
  // the row, so changing one node's text must not rebuild 1500 rows.
  const label = { textContent: 'Old' };
  const classes = new Set();
  const li = {
    dataset: { id: 'r' },
    querySelector: (sel) => (sel === '.ol-label' ? label : null),
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
  };
  const { pane, body } = makePane();
  body.firstElementChild = { fake: true };
  body.querySelectorAll = (sel) => (sel === '.ol-node' ? [li] : []);
  const { renderOutline } = loadFns(['renderOutline'], outlineStubs({
    pane, prev: '<ul class="ol-tree"></ul>', prevShape: '["r",0]',
    labels: new Map([['r', 'Old']]),
  }));
  renderOutline();
  assert.equal(body.writes, 0, 'the tree markup must not be replaced');
  assert.equal(label.textContent, 'Root');
});

test('a folded dock is skipped entirely', () => {
  const { pane, body } = makePane();
  const { renderOutline } = loadFns(['renderOutline'], outlineStubs({ pane, prev: '', open: false }));
  renderOutline();
  assert.equal(body.writes, 0, 'a closed pane is invisible; nothing should be built');
});

test('the folded-dock guard is wired to the toggle', () => {
  assert.match(extractFunction('renderOutline'),
    /if\(!document\.body\.classList\.contains\('outline-open'\)\) return;/);
  assert.match(SRC, /if\(document\.body\.classList\.contains\('outline-open'\)\) withChildIndex\(renderOutline\);/);
});

test('the outline build always runs inside a child index', () => {
  // renderOutline walks the tree with childrenOf(). Outside an index that
  // degrades to a full scan per node, which measured ~400 ms at 1571 nodes
  // when the dock was first opened from the layout picker.
  const layout = extractFunction('applyUiLayout');
  assert.match(layout, /withChildIndex\(renderOutline\);/);
  const { buildChildIndex } = loadFns(['buildChildIndex'], { map: null });
  assert.deepEqual(Object.keys(buildChildIndex()), [], 'boot and the empty state have no map to index');
});

test('applyUiLayout resets every outline cache when the pane is removed', () => {
  const fn = extractFunction('applyUiLayout');
  assert.match(fn, /if\(!outline\)\{\s*document\.getElementById\('outlinePane'\)\?\.remove\(\);\s*_olPrev='';/, 
    'removing the pane must clear the html-compare cache so the next fresh pane renders');
  assert.match(fn, /_olShape=''; _olLabels=new Map\(\); _olSel=null;/, 'the shape, label and selection caches must reset too');
});
