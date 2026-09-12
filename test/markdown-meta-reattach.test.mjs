// Markdown mode carries what Markdown cannot say (ref, citation, box colour,
// size) in a <!-- mindspark --> meta comment keyed by POSITION: '0.7' is the
// root's eighth child. The parser hands out fresh ids, so position was the
// only handle - and it drifts the moment a line is added or removed above.
// In the demo map one sibling typed above the citations moved Patil's ref and
// DOI onto the new line, Zanger's onto Patil, and left Zanger bare (the
// screenshot that prompted this). Each entry now carries a fingerprint of its
// node's text and is re-attached by that first; position is only trusted for
// a rename, or for an export old enough to carry no fingerprints.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

let n = 0;
const fns = loadFns(['parseMarkdownOutline', 'mdInlineToHtml', 'escapeHtml', 'metaFingerprint'], {
  uid: () => 'p' + (++n),
  INLINE_HTML_RE: extractConst('INLINE_HTML_RE'),
  sanitizeInlineHTML: s => s,
  parseFrontmatterFields: () => [],
  frontmatterFieldsToHtml: () => '',
  document: undefined,
});
const { parseMarkdownOutline, metaFingerprint } = fns;

/** Markdown for a root with the given top-level lines, plus a meta comment. */
const doc = (lines, meta) => '<!-- mindspark\n' + JSON.stringify({ nodes: meta }) + '\n-->\n# Root\n' + lines.map(l => '- ' + l).join('\n') + '\n';
const fp = metaFingerprint;
/** Children of the root, in document order, reduced to what matters. */
function rootKids(md) {
  const m = parseMarkdownOutline(md, 'x');
  return Object.values(m.nodes).filter(x => x.parent === m.rootId).map(x => ({ text: x.text, ref: !!x.ref, doi: x.citation ? x.citation.doi : undefined, color: x.color }));
}

const PATIL = 'Patil, Prasad (2026). Quantum State Measurement', ZANGER = 'Zanger, Benjamin (2021). Quantum Algorithms';
const META = {   // what buildMarkdown writes for the demo's three siblings
  '0': { t: fp('Root') },
  '0.1': { t: fp(PATIL), ref: 1, citation: { doi: '10.1109/tim' } },
  '0.2': { t: fp(ZANGER), ref: 1, citation: { doi: '10.22331/q' } },
};

describe('meta re-attachment after a structural Markdown edit', () => {
  test('unchanged document: everything lands where it was', () => {
    const k = rootKids(doc(['Python list', PATIL, ZANGER], META));
    assert.deepEqual(k.map(x => [x.ref, x.doi]), [[false, undefined], [true, '10.1109/tim'], [true, '10.22331/q']]);
  });

  test('a sibling inserted above the citations: refs stay with their text (the demo bug)', () => {
    const k = rootKids(doc(['Python list', 'A new branch', PATIL, ZANGER], META));
    assert.deepEqual(k.map(x => [x.text.slice(0, 6), x.ref, x.doi]), [
      ['Python', false, undefined], ['A new ', false, undefined], ['Patil,', true, '10.1109/tim'], ['Zanger', true, '10.22331/q'],
    ]);
  });

  test('a sibling deleted above them', () => {
    const k = rootKids(doc([PATIL, ZANGER], META));
    assert.deepEqual(k.map(x => [x.ref, x.doi]), [[true, '10.1109/tim'], [true, '10.22331/q']]);
  });

  test('siblings reordered', () => {
    const k = rootKids(doc([ZANGER, 'Python list', PATIL], META));
    assert.deepEqual(k.map(x => [x.text.slice(0, 6), x.doi]), [['Zanger', '10.22331/q'], ['Python', undefined], ['Patil,', '10.1109/tim']]);
  });

  test('a rename in place keeps its meta: no sibling claims that entry by text', () => {
    const k = rootKids(doc(['Python list', 'Patil et al., retitled', ZANGER], META));
    assert.deepEqual(k.map(x => [x.ref, x.doi]), [[false, undefined], [true, '10.1109/tim'], [true, '10.22331/q']]);
  });

  test('a rename plus an insert above: the renamed node loses its entry rather than a stranger gaining it', () => {
    // Nothing matches 'Patil retitled' by text; its old position now holds
    // 'New', whose text does not match the Patil entry either, and the Patil
    // entry's text is claimed by no one. Position then says the entry belongs
    // to 'New' - the one ambiguous case, and the same answer as before.
    const k = rootKids(doc(['Python list', 'New', 'Patil retitled', ZANGER], META));
    assert.equal(k[3].doi, '10.22331/q', 'Zanger still follows its text');
    assert.equal(k[1].doi, '10.1109/tim');
  });

  test('inline formatting and entities do not break the match', () => {
    const meta = { '0': { t: fp('Root') }, '0.0': { t: fp('R &amp; D <b>plan</b>'), color: '#ffedc2' } };
    const k = rootKids(doc(['Intro', 'R & D **plan**'], meta));
    assert.equal(k[1].color, '#ffedc2');
    assert.equal(k[0].color, undefined, 'the entry does not fall back onto the node now at position 0');
  });

  test('meta deeper in the tree follows its ancestor by text', () => {
    const meta = { '0': { t: fp('Root') }, '0.1': { t: fp('Branch') }, '0.1.0': { t: fp('Leaf'), color: '#dcefce' } };
    const md = '<!-- mindspark\n' + JSON.stringify({ nodes: meta }) + '\n-->\n# Root\n- Inserted above\n- Other\n- Branch\n  - Leaf\n';
    const m = parseMarkdownOutline(md, 'x');
    const leaf = Object.values(m.nodes).find(x => x.text === 'Leaf');
    assert.equal(leaf.color, '#dcefce');
    assert.ok(!Object.values(m.nodes).some(x => x.text !== 'Leaf' && x.color), 'no other node got the colour');
  });

  test('an export without fingerprints keeps the old positional behaviour', () => {
    const legacy = { '0.1': { ref: 1, citation: { doi: 'A' } }, '0.2': { ref: 1, citation: { doi: 'B' } } };
    const k = rootKids(doc(['Python list', PATIL, ZANGER], legacy));
    assert.deepEqual(k.map(x => x.doi), [undefined, 'A', 'B']);
  });
});

describe('metaFingerprint', () => {
  test('tags, entities, breaks, whitespace and case are normalised; long text is capped', () => {
    assert.equal(fp('Python<br>NumPy &amp; Pandas'), fp('Python\nNumPy & Pandas'));
    assert.equal(fp('<b>Bold</b>  text'), 'bold text');
    assert.equal(fp('  A &nbsp; B '), 'a b');
    assert.equal(fp(null), '');
    assert.equal(fp('x'.repeat(100)).length, 48);
  });
});

describe('buildMarkdown writes the fingerprints', () => {
  test('every node with meta gets t; an ancestor of one gets a fingerprint-only entry; a plain node gets nothing', () => {
    const map = { rootId: 'r', nodes: {
      r: { id: 'r', text: 'Root', parent: null },
      a: { id: 'a', text: 'Plain', parent: 'r' },
      b: { id: 'b', text: 'Branch', parent: 'r' },
      c: { id: 'c', text: 'Cited', parent: 'b', ref: true, citation: { doi: 'D' } },
    } };
    const kids = id => Object.values(map.nodes).filter(x => x.parent === id).map(x => x.id);
    const { buildMarkdown } = loadFns(['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml'], {
      map, childrenOf: kids, nodeTextPlain: t => t, htmlToInlineMd: t => t, notesToMdBlocks: () => [],
      frontmatterNodeToYaml: () => '', hasInlineMarkup: () => false,
    });
    const md = buildMarkdown('r', { meta: true });
    const meta = JSON.parse(md.match(/<!--\s*mindspark\s*\n([\s\S]*?)\n\s*-->/)[1]);
    assert.deepEqual(Object.keys(meta.nodes).sort(), ['0', '0.1', '0.1.0']);
    assert.deepEqual(meta.nodes['0.1.0'], { ref: 1, citation: { doi: 'D' }, t: 'cited' });
    assert.deepEqual(meta.nodes['0.1'], { t: 'branch' });
    assert.deepEqual(meta.nodes['0'], { t: 'root' });
  });
});
