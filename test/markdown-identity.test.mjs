// Typing in the Markdown editor used to cost three things silently. The parser
// hands out fresh ids on every pass and applyMdToMap swapped map.nodes
// wholesale, so every cross-link pointed at dead ids (and the next load pruned
// it); and the per-node meta comment carried neither the marker badge nor the
// branch label, the two node fields Markdown has no syntax for.
//
// carryMarkdownIds() now re-keys the parsed nodes onto the ids they had, and
// _nodeMeta()/applyMeta carry marker and label.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const RE = { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') };
let seq = 0;
const { carryMarkdownIds } = loadFns(['carryMarkdownIds', 'metaFingerprint'], { uid: () => 'u' + (++seq) });

function build(map) {
  const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
  const fns = loadFns(['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml', 'nodeTextPlain', 'htmlToInlineMd', 'notesToMdBlocks', 'frontmatterNodeToYaml'],
    { map, childrenOf, hasInlineMarkup: t => RE.INLINE_HTML_RE.test(t || '') || RE.ENTITY_RE.test(t || ''), ...RE });
  return fns.buildMarkdown(map.rootId, { rich: true, meta: true, lineMap: [] });
}
function parse(md) {
  let k = 0;
  const fns = loadFns(['parseMarkdownOutline', 'mdInlineToHtml', 'escapeHtml', 'metaFingerprint', 'scrubRawHtmlBlock'], { uid: () => 'p' + (++k), ...RE });
  return fns.parseMarkdownOutline(md, 'T');
}
const byText = (nodes, t) => Object.values(nodes).find(n => n.text === t);

const base = () => ({ rootId: 'r', title: 'T', links: [{ from: 'a', to: 'b', label: 'depends' }], nodes: {
  r: { id: 'r', text: 'Root', parent: null },
  a: { id: 'a', text: 'Alpha', parent: 'r', marker: '⭐', label: 'why' },
  b: { id: 'b', text: 'Beta', parent: 'r' },
  c: { id: 'c', text: 'Gamma', parent: 'b' },
} });

describe('marker and branch label survive Markdown', () => {
  test('buildMarkdown writes them into the meta comment and the parser reads them back', () => {
    const md = build(base());
    assert.match(md, /"marker":"⭐"/);
    assert.match(md, /"label":"why"/);
    const back = parse(md);
    const alpha = byText(back.nodes, 'Alpha');
    assert.equal(alpha.marker, '⭐');
    assert.equal(alpha.label, 'why');
  });
});

describe('carryMarkdownIds keeps node identity', () => {
  const apply = (edit) => {
    const m = base();
    const parsed = parse(edit(build(m)));
    return carryMarkdownIds(m.nodes, m.rootId, parsed);
  };
  test('an unchanged document maps every node back onto its own id', () => {
    const out = apply(md => md + ' ');
    assert.deepEqual(Object.keys(out.nodes).sort(), ['a', 'b', 'c', 'r']);
    assert.equal(out.rootId, 'r');
    assert.equal(out.nodes.c.parent, 'b');
  });
  test('an edited line keeps its id, and the cross-link still resolves', () => {
    const out = apply(md => md.replace('- Beta', '- Beta renamed'));
    assert.equal(out.nodes.b.text, 'Beta renamed');
    assert.ok(out.nodes.a && out.nodes.b, 'both ends of the link are still there');
  });
  test('an inserted line gets a fresh id and steals nobody else\'s', () => {
    const out = apply(md => md.replace('- Alpha', '- New one\n- Alpha'));
    assert.equal(out.nodes.a.text, 'Alpha');
    const fresh = Object.values(out.nodes).find(n => n.text === 'New one');
    assert.ok(fresh && !['r', 'a', 'b', 'c'].includes(fresh.id));
  });
  test('a deleted line takes its id with it', () => {
    const out = apply(md => md.replace(/- Alpha\n/, ''));
    assert.equal(out.nodes.a, undefined);
    assert.equal(out.nodes.b.text, 'Beta');
  });
  test('a node moved under another parent keeps its id', () => {
    const out = apply(md => md.replace('  - Gamma', '').replace('- Alpha', '- Alpha\n  - Gamma'));
    assert.equal(out.nodes.c.parent, 'a');
  });
  test('applyMdToMap uses it and prunes only links whose ends are gone', () => {
    const body = SRC.slice(SRC.indexOf('function applyMdToMap('), SRC.indexOf('function toggleMdMode('));
    assert.match(body, /carryMarkdownIds\(map\.nodes, map\.rootId, parsed\)/);
    assert.match(body, /map\.links=\(map\.links\|\|\[\]\)\.filter\(l=>map\.nodes\[l\.from\] && map\.nodes\[l\.to\]\)/);
    assert.match(body, /sanitizeNodeFields/);
  });
});

// applyMdToMap() re-keys the parsed nodes, but it replaces map.nodes wholesale:
// the new node objects have no measured w/h. render() keeps the old DOM element
// when the node's signature is unchanged, and that reuse path used to skip the
// measure pass, on the assumption that the node object still carried the size.
// So every Markdown edit left all visible nodes sized 120x40 as far as the
// layout was concerned. Columns drifted and a card wider than 120px had its
// children placed inside its own right edge - visible as a map that no longer
// lines up after cutting and pasting a section.
describe('Markdown sync keeps measured node sizes', () => {
  const { needsMeasureOnReuse } = loadFns(['needsMeasureOnReuse']);

  test('a replacement node with no size is re-measured', () => {
    assert.equal(needsMeasureOnReuse('tree', {}), true);
    assert.equal(needsMeasureOnReuse('tree', { w: 0, h: 40 }), true);
    assert.equal(needsMeasureOnReuse('tree', { w: 120, h: 0 }), true);
  });

  test('a node that already carries its measured size is left alone', () => {
    assert.equal(needsMeasureOnReuse('tree', { w: 183, h: 36 }), false);
  });

  test('a tree table always re-measures, size or not', () => {
    assert.equal(needsMeasureOnReuse('treetable', { w: 183, h: 36 }), true);
  });

  test('render applies the check on its element-reuse path', () => {
    const body = SRC.slice(SRC.indexOf('function render('), SRC.indexOf('function scheduleTokenTotal('));
    assert.match(body, /needsMeasureOnReuse\(_run\.strategy, n\)/);
  });
});
