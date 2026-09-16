// The whole map looked faded/transparent after the first click of a session,
// on some machines, until a map switch re-rendered it. Every node carried the
// search .dim class (opacity .28) while the search bar was closed: a value had
// landed in the hidden #search field without anyone opening search (browser
// or extension autofill on the first user gesture, a restored form value),
// and its input event ran doSearch() against a query nothing matched.
// doSearch() now never dims behind a closed bar, and openSearch() starts from
// an empty field, since closeSearch() is the only path that leaves one behind.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

function harness({ open, texts = ['Machine Learning', 'Supervised learning', 'Neural networks'] }) {
  const cls = () => { const s = new Set(); return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)), contains: c => s.has(c), toggle(c, on) { on ? s.add(c) : s.delete(c); }, has: c => s.has(c) }; };
  const nodes = texts.map((t, i) => ({ dataset: { id: 'n' + i }, classList: cls() }));
  const map = { nodes: Object.fromEntries(texts.map((t, i) => ['n' + i, { text: t }])) };
  const wrap = { classList: cls(), style: {} };
  if (open) wrap.classList.add('open');
  const search = { value: '', focused: 0, selected: 0, focus() { this.focused++; }, select() { this.selected++; } };
  const count = { textContent: '' };
  const els = { '#searchWrap': wrap, '#search': search, '#searchCount': count, '#searchBtn': null };
  const $ = sel => els[sel];
  const document = { querySelectorAll: () => nodes, body: { classList: cls() } };
  const fns = loadFns(['doSearch', 'openSearch'], {
    $, document, map, searchMatches: [], searchPos: -1,
    INLINE_HTML_RE: /<[a-z]/i, nodeTextPlain: s => s,
  });
  return { ...fns, nodes, wrap, search, count };
}
const dimmed = h => h.nodes.filter(n => n.classList.contains('dim')).length;
const matched = h => h.nodes.filter(n => n.classList.contains('match')).length;

describe('a value in the hidden search field never dims the map', () => {
  test('bar closed: a query nothing matches dims no node and reports no count', () => {
    const h = harness({ open: false });
    h.doSearch('zzz');
    assert.equal(dimmed(h), 0);
    assert.equal(matched(h), 0);
    assert.equal(h.count.textContent, '');
  });

  test('bar closed: even a matching query is ignored (there is no bar to show the result in)', () => {
    const h = harness({ open: false });
    h.doSearch('neural');
    assert.equal(dimmed(h), 0);
    assert.equal(matched(h), 0);
  });

  test('bar closed: an empty query still clears leftovers', () => {
    const h = harness({ open: false });
    h.nodes.forEach(n => n.classList.add('dim'));
    h.doSearch('');
    assert.equal(dimmed(h), 0);
  });

  test('bar open: search works as before - matches highlighted, the rest dimmed', () => {
    const h = harness({ open: true });
    h.doSearch('learning');
    assert.equal(matched(h), 2);
    assert.equal(dimmed(h), 1);
    assert.equal(h.count.textContent, '2 found');
    h.doSearch('zzz');
    assert.equal(dimmed(h), 3);
    assert.equal(h.count.textContent, 'none');
  });
});

describe('openSearch starts from an empty field', () => {
  test('a stray value left while the bar was closed is dropped on open', () => {
    const h = harness({ open: false });
    h.search.value = 'autofilled';
    h.openSearch(false);
    assert.equal(h.search.value, '');
    assert.equal(h.wrap.classList.contains('open'), true);
    assert.equal(h.search.focused, 1);
  });

  test('re-opening (Ctrl+F while already open) keeps what the user typed', () => {
    const h = harness({ open: true });
    h.search.value = 'typed';
    h.openSearch(false);
    assert.equal(h.search.value, 'typed');
  });
});
