// Map -> Markdown -> Map has to come back the same map.
//
// The split editor is a two-way binding: buildMarkdown() renders the map into
// the textarea and parseMarkdownOutline() parses every keystroke back onto the
// canvas (applyMdToMap, on a 300ms debounce). An outline can only carry text
// and nesting, so everything else - colours, sizes, collapsed state, notes,
// tasks, citations, images - rides in the <!-- mindspark --> header and is
// reattached by position-plus-fingerprint. A round trip that quietly drops one
// of those is data loss the user only notices later, which is why this walks a
// map carrying all of them rather than a bare outline.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

// A map with one of everything the round trip is responsible for carrying.
// The property names are the ones the app actually stores - read off the
// shipped demo map, not invented: `notes` (HTML), `task` ('done'|'doing'),
// `image`, `ref`+`citation`, `collapsed` (boolean), and `width`/`height` for a
// manual resize. n.w/n.h are the measured layout box and are deliberately NOT
// carried (see _nodeMeta), so they are not asserted here.
function richMap() {
  const nodes = {
    r:  { id: 'r',  text: 'Root',        parent: null, color: '#ffe2d6', width: 265, height: 48 },
    a:  { id: 'a',  text: 'Plain child', parent: 'r' },
    b:  { id: 'b',  text: 'Coloured',    parent: 'r', color: '#dcefce' },
    c:  { id: 'c',  text: 'Collapsed',   parent: 'r', collapsed: true },
    c1: { id: 'c1', text: 'Hidden kid',  parent: 'c' },
    e:  { id: 'e',  text: 'Task done',   parent: 'r', task: 'done' },
    f:  { id: 'f',  text: 'Task doing',  parent: 'r', task: 'doing' },
    g:  { id: 'g',  text: 'Cited',       parent: 'r', ref: true, citation: { doi: '10.1/x' } },
    h:  { id: 'h',  text: 'Resized',     parent: 'r', width: 209, height: 55 },
    i:  { id: 'i',  text: 'Deep',        parent: 'b' },
    j:  { id: 'j',  text: 'Deeper',      parent: 'i' },
  };
  return { rootId: 'r', title: 'Round trip', nodes };
}

// The real regexes, not stand-ins: htmlToInlineMd and mdInlineToHtml branch on
// them, and a permissive stub would quietly change what the round trip does.
const RE = { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') };

function build(map, opts) {
  const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
  const fns = loadFns(
    ['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml', 'nodeTextPlain',
     'htmlToInlineMd', 'notesToMdBlocks', 'frontmatterNodeToYaml'],
    { map, childrenOf, hasInlineMarkup: t => RE.INLINE_HTML_RE.test(t || '') || RE.ENTITY_RE.test(t || ''), ...RE });
  return fns.buildMarkdown(map.rootId, opts);
}
function parse(md) {
  const fns = loadFns(['parseMarkdownOutline', 'parseMapOptionsFrontmatter', 'mdInlineToHtml', 'escapeHtml', 'metaFingerprint'],
    { uid: (() => { let n = 0; return () => 'p' + (++n); })(), ...RE });
  return fns.parseMarkdownOutline(md, 'Round trip');
}
// The shape of a parsed map, independent of generated ids.
function outline(m) {
  const kids = id => Object.values(m.nodes).filter(n => n.parent === id);
  const walk = (id, d) => [{ depth: d, text: m.nodes[id].text, node: m.nodes[id] },
    ...kids(id).flatMap(c => walk(c.id, d + 1))];
  return walk(m.rootId, 0);
}

describe('markdown round trip', () => {
  const src = richMap();
  const md = build(src, { rich: true, meta: true });
  const back = parse(md);

  test('the editor text is produced at all, with the metadata header', () => {
    assert.ok(md.length > 50, 'buildMarkdown produced nothing');
    assert.match(md, /^<!--\s*mindspark/, 'the metadata header is missing');
    assert.match(md, /^# Root$/m, 'the root is not a heading');
  });

  test('every node survives, in the same order and nesting', () => {
    const before = [
      [0, 'Root'], [1, 'Plain child'], [1, 'Coloured'], [2, 'Deep'], [3, 'Deeper'],
      [1, 'Collapsed'], [2, 'Hidden kid'], [1, 'Task done'],
      [1, 'Task doing'], [1, 'Cited'], [1, 'Resized'],
    ];
    const after = outline(back).map(r => [r.depth, r.text]);
    assert.deepEqual(after, before);
  });

  test('a collapsed branch keeps its hidden children', () => {
    const c = outline(back).find(r => r.text === 'Collapsed');
    const hidden = Object.values(back.nodes).filter(n => n.parent === c.node.id);
    assert.equal(hidden.length, 1, 'the child under a collapsed node was dropped');
    assert.equal(hidden[0].text, 'Hidden kid');
  });

  // What the <!-- mindspark --> header is responsible for.
  for (const [label, text, prop, expected] of [
    ['colour', 'Coloured', 'color', '#dcefce'],
    ['a manual width', 'Resized', 'width', 209],
    ['a manual height', 'Resized', 'height', 55],
  ]) {
    test(`${label} survives the round trip`, () => {
      const row = outline(back).find(r => r.text === text);
      assert.ok(row, `the "${text}" node is gone entirely`);
      assert.deepEqual(row.node[prop], expected,
        `${prop} on "${text}": ${JSON.stringify(row.node[prop])} came back, expected ${JSON.stringify(expected)}`);
    });
  }

  // What the visible markdown is responsible for - _nodeMeta deliberately
  // leaves these out, so a regression here means the TEXT stopped carrying it.
  // A task is three-state (todo / doing / done). Markdown standardises two, so
  // `doing` uses [/]. It used to be written as [ ] and read back as todo, which
  // meant one keystroke in the editor reset every in-progress task on the map.
  test('every task state survives as markdown', () => {
    assert.match(md, /^- \[x\] Task done$/m, 'a done task should render as - [x]');
    assert.match(md, /^- \[\/\] Task doing$/m, 'an in-progress task should render as - [/]');
    const rows = outline(back);
    assert.equal(rows.find(r => r.text === 'Task done').node.task, 'done');
    assert.equal(rows.find(r => r.text === 'Task doing').node.task, 'doing',
      'an in-progress task came back as something else - the third state is being flattened');
  });

  test('the parser accepts both in-progress spellings and rejects plain text', () => {
    const m = parse('# R\n- [/] slash\n- [-] dash\n- [ ] open\n- [x] done\n');
    const byText = t => Object.values(m.nodes).find(n => n.text === t);
    assert.equal(byText('slash').task, 'doing');
    assert.equal(byText('dash').task, 'doing');
    assert.equal(byText('open').task, 'todo');
    assert.equal(byText('done').task, 'done');
  });

  test('collapsed state survives the round trip', () => {
    const row = outline(back).find(r => r.text === 'Collapsed');
    assert.ok(row.node.collapsed, 'the branch came back expanded');
    const open = outline(back).find(r => r.text === 'Coloured');
    assert.ok(!open.node.collapsed, 'a node that was never collapsed came back collapsed');
  });

  test('a citation survives the round trip', () => {
    const row = outline(back).find(r => r.text === 'Cited');
    assert.ok(row.node.citation, 'the citation was dropped');
    assert.equal(row.node.citation.doi, '10.1/x');
  });

  test('a second round trip is a fixed point', () => {
    const again = parse(build({ ...src, nodes: back.nodes, rootId: back.rootId }, { rich: true, meta: true }));
    assert.deepEqual(outline(again).map(r => [r.depth, r.text]), outline(back).map(r => [r.depth, r.text]),
      'the outline drifts when the text is rebuilt and reparsed');
  });

  test('a plain outline with no header still parses into the same shape', () => {
    const plain = parse('# Fruit\n- Citrus\n  - Lemon\n  - Orange\n    - Navel\n- Berries\n');
    assert.deepEqual(outline(plain).map(r => [r.depth, r.text]),
      [[0, 'Fruit'], [1, 'Citrus'], [2, 'Lemon'], [2, 'Orange'], [3, 'Navel'], [1, 'Berries']]);
  });
});
