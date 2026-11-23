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
  const fns = loadFns(['parseMarkdownOutline', 'stripIndent', 'parseMapOptionsFrontmatter', 'mdInlineToHtml', 'escapeHtml', 'metaFingerprint'],
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

// A table, code, divider or raw HTML node is a block node, and it can have
// children like any other. buildMarkdown used to return from a block without
// walking them, so they were missing from the Markdown and the next edit in the
// Markdown pane (which rebuilds the map from that text) deleted them: the
// ToDo's map lost a YouTube link hung off a code block that way. The importer
// also placed a divider or raw HTML block at the section level whatever its
// indent, moving it out from under its bullet, and kept the indent inside the
// raw HTML so every round trip pushed it two spaces further right.
describe('block nodes keep their place and their children', () => {
  // notesToMdBlocks parses through a <template>, which node has no DOM for. A
  // stand-in that answers for the two blocks used here keeps the test on what
  // it is about: where buildMarkdown puts blocks and their children.
  const ROWS = ['| A | B |', '| --- | --- |', '| 1 | 2 |'];
  const notesToMdBlocks = h => (/<table/i.test(h) ? [{ table: ROWS }] : /<pre/i.test(h) ? [{ code: 'tree\n  leaf' }] : []);
  const RAW = '<details>\n<summary>More</summary>\n<p>Body</p>\n</details>';
  function buildB(map) {
    const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
    const fns = loadFns(
      ['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml', 'nodeTextPlain', 'htmlToInlineMd', 'frontmatterNodeToYaml'],
      { map, childrenOf, notesToMdBlocks, hasInlineMarkup: t => RE.INLINE_HTML_RE.test(t || '') || RE.ENTITY_RE.test(t || ''), ...RE });
    return fns.buildMarkdown(map.rootId, { rich: true });
  }
  const src = { rootId: 'r', nodes: {
    r:   { id: 'r',   text: 'Root',         parent: null },
    p:   { id: 'p',   text: 'Polymathy',    parent: 'r' },
    cd:  { id: 'cd',  text: 'code',         parent: 'p', html: '<pre><code>tree\n  leaf</code></pre>' },
    yt:  { id: 'yt',  text: 'Video link',   parent: 'cd' },
    tb:  { id: 'tb',  text: 'table',        parent: 'p', html: '<table><tr><td>1</td></tr></table>' },
    tk:  { id: 'tk',  text: 'Table kid',    parent: 'tb' },
    hr:  { id: 'hr',  text: '',             parent: 'p', hr: true },
    hk:  { id: 'hk',  text: 'Under rule',   parent: 'hr' },
    rw:  { id: 'rw',  text: 'details block', parent: 'p', html: RAW, raw: true },
    rk:  { id: 'rk',  text: 'Under raw',    parent: 'rw' },
    nx:  { id: 'nx',  text: 'Next',         parent: 'r' },
  } };
  const md = buildB(src);
  const back = parse(md);

  test('the children of every block node are written out', () => {
    for (const t of ['Video link', 'Table kid', 'Under rule', 'Under raw']) {
      assert.ok(md.split('\n').some(l => /^\s+- /.test(l) && l.trim() === '- ' + t), `"${t}" is missing from the Markdown:\n${md}`);
    }
  });

  test('blocks and their children come back in the same place', () => {
    assert.deepEqual(outline(back).map(r => [r.depth, r.text]), [
      [0, 'Root'], [1, 'Polymathy'],
      [2, 'code'], [3, 'Video link'],
      [2, 'table'], [3, 'Table kid'],
      [2, ''], [3, 'Under rule'],
      [2, 'details block'], [3, 'Under raw'],
      [1, 'Next'],
    ]);
  });

  test('a raw HTML block comes back without the indent it was written at', () => {
    const raw = Object.values(back.nodes).find(n => n.raw);
    assert.equal(raw.html, RAW);
  });

  test('a second round trip writes the same Markdown', () => {
    assert.equal(buildB(back), md, 'the text drifts on every round trip');
  });
});

describe('paragraph nodes and notes blocks stay under their node', () => {
  // Two shapes that used to leave their node on the first edit in the Markdown
  // pane (which rebuilds the map from the text). A paragraph node under a bullet
  // is written indented with no marker, and the importer read every plain line
  // at the section level. Code and tables in a node's notes were written flush
  // left, which ends the list, so they came back hung off the section.
  const notesToMdBlocks = h => (/<table/i.test(h) ? [{ table: ['| A | B |', '| --- | --- |', '| 1 | 2 |'] }]
    : /<pre/i.test(h) ? [{ code: 'x\n  y' }] : []);
  function buildN(map) {
    const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
    const fns = loadFns(
      ['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml', 'nodeTextPlain', 'htmlToInlineMd', 'frontmatterNodeToYaml'],
      { map, childrenOf, notesToMdBlocks, hasInlineMarkup: t => RE.INLINE_HTML_RE.test(t || '') || RE.ENTITY_RE.test(t || ''), ...RE });
    return fns.buildMarkdown(map.rootId, { rich: true });
  }
  const src = { rootId: 'r', nodes: {
    r:   { id: 'r',   text: 'Root',                    parent: null },
    a:   { id: 'a',   text: 'Item',                    parent: 'r' },
    pa:  { id: 'pa',  text: 'A plain paragraph.',      parent: 'a', para: true },
    sb:  { id: 'sb',  text: 'Sibling after it',        parent: 'a' },
    pp:  { id: 'pp',  text: 'Paragraph with a kid',    parent: 'a', para: true },
    pk:  { id: 'pk',  text: 'Paragraph kid',           parent: 'pp' },
    nc:  { id: 'nc',  text: 'Code in notes',           parent: 'r', notes: '<pre><code>x\n  y</code></pre>' },
    nk:  { id: 'nk',  text: 'Its kid',                 parent: 'nc' },
    nt:  { id: 'nt',  text: 'Table in notes',          parent: 'r', notes: '<table><tr><td>1</td></tr></table>' },
    z:   { id: 'z',   text: 'Last',                    parent: 'r' },
  } };
  const md = buildN(src);
  const back = parse(md);
  const rows = outline(back).map(r => [r.depth, r.text]);

  test('a paragraph node under a bullet comes back under that bullet', () => {
    assert.ok(md.split('\n').includes('  A plain paragraph.'), `written indented, with no marker:\n${md}`);
    assert.deepEqual(rows.slice(0, 6), [
      [0, 'Root'], [1, 'Item'],
      [2, 'A plain paragraph.'], [2, 'Sibling after it'],
      [2, 'Paragraph with a kid'], [3, 'Paragraph kid'],
    ], `outline:\n${JSON.stringify(rows)}\nfrom:\n${md}`);
    const p = Object.values(back.nodes).find(n => n.text === 'A plain paragraph.');
    assert.equal(p.para, true, 'it must stay a paragraph, not turn into a bullet');
  });

  test('an indented paragraph followed by a bullet is not taken as a lead-in', () => {
    const sib = Object.values(back.nodes).find(n => n.text === 'Sibling after it');
    assert.equal(back.nodes[sib.parent].text, 'Item', 'the next bullet was re-parented under the paragraph');
  });

  test('code and tables in notes are written at the note indent', () => {
    const L = md.split('\n');
    assert.ok(L.includes('  ```') && L.includes('  x') && L.includes('    y'), `the fence is not indented under its item:\n${md}`);
    assert.ok(L.includes('  | A | B |'), `the table is not indented under its item:\n${md}`);
    assert.ok(!L.some(l => /^(```|\|)/.test(l)), `a notes block was written flush left, which ends the list:\n${md}`);
  });

  test('code and tables in notes come back under their node, not the section', () => {
    assert.deepEqual(rows.slice(6), [
      [1, 'Code in notes'], [2, 'code'], [2, 'Its kid'],
      [1, 'Table in notes'], [2, 'table'],
      [1, 'Last'],
    ], `outline:\n${JSON.stringify(rows)}\nfrom:\n${md}`);
    const code = Object.values(back.nodes).find(n => n.text === 'code');
    assert.equal(code.html, '<pre><code>x\n  y</code></pre>', 'only the note indent comes off the code');
  });
});

test('a flush-left lead-in line above a list still becomes the parent of that list', () => {
  // The indented-paragraph rule above must not reach this shape, which is how
  // LLM answers and READMEs group bullets under a bold line.
  const rows = outline(parse('# Doc\n\n**Editing**\n- one\n- two\n')).map(r => [r.depth, r.text]);
  assert.deepEqual(rows, [[0, 'Doc'], [1, '<b>Editing</b>'], [2, 'one'], [2, 'two']], JSON.stringify(rows));
});
