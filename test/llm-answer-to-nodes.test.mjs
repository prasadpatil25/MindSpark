// "Add as child nodes" in the Build Prompt panel hands an LLM answer to
// addResponseAsNodes(). Answers are Markdown, so the result on the canvas has
// to be what importing that Markdown would give: headings as branches,
// indentation as nesting, **bold** and `code` as formatting rather than literal
// markers, and nothing silently dropped. The bullet-only scan this replaced
// lost headings, flattened tab-indented sub-bullets and cut a bullet-less
// answer to its first 60 characters.
//
// The real functions are lifted from public/app.js (see helpers/load-app-fns.mjs)
// and run against a tiny in-memory map; DOM-only paths (raw HTML in the answer)
// are stubbed because plain Markdown never reaches them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

function harness() {
  const map = {
    id: 'm', rootId: 'root',
    nodes: {
      root: { id: 'root', text: 'Root', parent: null, side: 'root', x: 0, y: 0 },
      a:    { id: 'a', text: 'A', parent: 'root', side: 'left', x: 10, y: 10, collapsed: true },
    },
  };
  const calls = [];
  let n = 0;
  const deps = {
    map,
    uid: () => 'n' + (++n),
    INLINE_HTML_RE: extractConst('INLINE_HTML_RE'),
    sanitizeInlineHTML: s => s,
    parseFrontmatterFields: () => [],
    frontmatterFieldsToHtml: () => '',
    childrenOf: id => Object.values(map.nodes).filter(x => x.parent === id).map(x => x.id),
    autoLayout: () => calls.push('autoLayout'),
    pushHistory: () => calls.push('pushHistory'),
    scheduleSave: () => calls.push('scheduleSave'),
    document: undefined,
  };
  const { addResponseAsNodes } = loadFns(
    ['addResponseAsNodes', 'parseMarkdownOutline', 'mdInlineToHtml', 'escapeHtml'], deps);
  const kidsOf = id => Object.values(map.nodes).filter(x => x.parent === id);
  return { map, calls, add: (pid, text) => addResponseAsNodes(pid, text), kidsOf };
}

describe('addResponseAsNodes - LLM answer becomes a real subtree', () => {
  test('headings become branches and their bullets nest under them', () => {
    const h = harness();
    const n = h.add('root', [
      '## Strengths', '- fast', '- small',
      '## Weaknesses', '- no tests',
    ].join('\n'));
    assert.equal(n, 5);
    const tops = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.deepEqual(tops.map(x => x.text), ['Strengths', 'Weaknesses']);
    assert.deepEqual(h.kidsOf(tops[0].id).map(x => x.text), ['fast', 'small']);
    assert.deepEqual(h.kidsOf(tops[1].id).map(x => x.text), ['no tests']);
  });

  test('inline markers become formatting, not literal characters', () => {
    const h = harness();
    h.add('root', '- **Key point** with `code`\n- *emphasis* and ~~gone~~');
    const [p, q] = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.equal(p.text, '<b>Key point</b> with <code>code</code>');
    assert.equal(q.text, '<i>emphasis</i> and <s>gone</s>');
  });

  test('tab-indented and 4-space-indented sub-bullets nest, and "1)" counts as a list', () => {
    const h = harness();
    h.add('root', '1) Step one\n\t- detail\n2) Step two\n    - detail two');
    const tops = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.deepEqual(tops.map(x => x.text), ['Step one', 'Step two']);
    assert.deepEqual(h.kidsOf(tops[0].id).map(x => x.text), ['detail']);
    assert.deepEqual(h.kidsOf(tops[1].id).map(x => x.text), ['detail two']);
  });

  test('an answer without bullets keeps every paragraph instead of 60 characters of the first', () => {
    const h = harness();
    const long = 'x'.repeat(120);
    const n = h.add('root', long + '\n\nSecond paragraph.');
    assert.equal(n, 2);
    const tops = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.equal(tops[0].text, long, 'nothing truncated');
    assert.equal(tops[1].text, 'Second paragraph.');
  });

  test('a single top-level heading is the one child, not an extra wrapper', () => {
    const h = harness();
    h.add('root', '# Summary\n- one\n- two');
    const tops = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.equal(tops.length, 1);
    assert.equal(tops[0].text, 'Summary');
    assert.deepEqual(h.kidsOf(tops[0].id).map(x => x.text), ['one', 'two']);
    assert.ok(!Object.values(h.map.nodes).some(x => /^ai-/.test(x.text)), 'the parser wrapper never lands on the map');
  });

  test('task checkboxes, blockquotes and fenced code carry over the way an import does', () => {
    const h = harness();
    h.add('root', '- [x] done thing\n- [ ] open thing\n> a note for the branch\n```js\nlet x = 1;\n```');
    const tops = h.kidsOf('root').filter(x => x.id !== 'a');
    assert.equal(tops[0].task, 'done');
    assert.equal(tops[1].task, 'todo');
    assert.equal(tops[1].notes, 'a note for the branch');
    const code = tops.find(x => x.html);
    assert.ok(code, 'fenced block becomes a code node');
    assert.match(code.html, /<pre><code>let x = 1;<\/code><\/pre>/);
  });

  test('new nodes belong to the chosen parent, inherit its side, and uncollapse it', () => {
    const h = harness();
    h.add('a', '- child\n  - grandchild');
    const kids = h.kidsOf('a');
    assert.equal(kids.length, 1);
    assert.equal(kids[0].side, 'left');
    assert.equal(h.kidsOf(kids[0].id)[0].side, 'left');
    assert.equal(h.map.nodes.a.collapsed, false, 'the user asked to see the answer');
    assert.equal(kids[0].color, '#fff');
    assert.ok(kids[0].created > 0);
    assert.deepEqual(h.calls, ['autoLayout', 'pushHistory', 'scheduleSave']);
  });

  test('branches added under the root alternate sides like addNode does', () => {
    const h = harness();   // root already has one child (a, left) so the next goes right
    h.add('root', '- one\n- two\n- three');
    const sides = h.kidsOf('root').filter(x => x.id !== 'a').map(x => x.side);
    assert.deepEqual(sides, ['left', 'right', 'left']);
  });

  test('ids never collide with nodes already on the map', () => {
    const h = harness();
    h.map.nodes.n2 = { id: 'n2', text: 'taken', parent: 'root', side: 'right', x: 0, y: 0 };
    h.add('root', '- fresh');
    assert.equal(h.map.nodes.n2.text, 'taken', 'existing node untouched');
    assert.ok(Object.values(h.map.nodes).some(x => x.text === 'fresh'));
  });

  test('an unknown parent or empty answer adds nothing', () => {
    const h = harness();
    assert.equal(h.add('nope', '- x'), 0);
    assert.equal(h.add('root', '   \n  '), 0);
    assert.equal(h.calls.length, 0);
  });
});
