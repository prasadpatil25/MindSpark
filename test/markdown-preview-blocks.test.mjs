// The Markdown preview must render the blocks the app itself writes.
//
// buildMarkdown() emits a code node as a fence indented under its parent
// bullet, and a table node as pipe rows in the same position. The preview's
// list scanner used to treat ANY line indented two spaces or more as a list
// continuation, so it swallowed the whole fenced block - every line of the
// code, and both fence markers, came back out as separate <li> items. The
// canvas rendered the same node as a proper <pre>, so one map showed two
// different things depending on which side you looked at, and an ASCII diagram
// lost its alignment in the half the user was reading.
//
// Tables were never broken; they are asserted here because they travel with
// code blocks in the same documents and share the block-dispatch loop.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const { mdToHtml } = loadFns(
  ['mdToHtml', 'scrubRawHtmlBlock', 'mdInlineToHtmlWithMath', 'renderMdList', 'mdInlineToHtml', 'escapeHtml',
   'parseMapOptionsFrontmatter', 'parseFrontmatterFields', 'frontmatterFieldsToHtml'],
  { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') });

const F = '```';
const codeOf = html => (html.match(/<code>([\s\S]*?)<\/code>/) || [])[1] ?? null;
const count = (html, re) => (html.match(re) || []).length;

describe('markdown preview - fenced code blocks', () => {
  // Every spelling of "a code block belonging to a bullet". The indented one is
  // what the app writes; the other two are what a person might type.
  for (const [label, md] of [
    ['at the top level', `${F}\nalpha\nbeta\n${F}\n`],
    ['indented under a bullet', `- item\n  ${F}\n  alpha\n  beta\n  ${F}\n`],
    ['after a blank line under a bullet', `- item\n\n  ${F}\n  alpha\n  beta\n  ${F}\n`],
    ['unindented after a bullet', `- item\n${F}\nalpha\nbeta\n${F}\n`],
    ['two levels deep', `- a\n  - b\n    ${F}\n    alpha\n    beta\n    ${F}\n`],
  ]) {
    test(`a fence ${label} renders as one <pre>`, () => {
      const html = mdToHtml(md);
      assert.equal(count(html, /<pre/g), 1, `expected exactly one <pre>:\n${html}`);
      assert.equal(codeOf(html), 'alpha\nbeta',
        `the code body is wrong - indentation must be stripped and nothing else:\n${html}`);
      assert.doesNotMatch(html, /```/, 'the fence markers leaked into the rendered output');
    });
  }

  test('the block keeps its own internal indentation', () => {
    const html = mdToHtml(`- item\n  ${F}\n  root\n  |\n  +- child\n  ${F}\n`);
    assert.equal(codeOf(html), 'root\n|\n+- child',
      'only the fence\'s own indent may be stripped; the diagram\'s own columns must survive');
  });

  test('a fence does not eat the list it follows', () => {
    const html = mdToHtml(`- one\n- two\n  ${F}\n  x\n  ${F}\n`);
    assert.equal(count(html, /<li>/g), 2, 'both bullets should still be list items');
    assert.equal(count(html, /<pre/g), 1);
  });

  test('a list with no fence is untouched', () => {
    const html = mdToHtml('- one\n- two\n  - nested\n');
    assert.equal(count(html, /<pre/g), 0);
    assert.equal(count(html, /<li>/g), 3, 'nesting must still work');
  });

  test('an unclosed fence does not swallow the rest of the document', () => {
    const html = mdToHtml(`- item\n  ${F}\n  alpha\n`);
    assert.equal(count(html, /<pre/g), 1);
    assert.match(html, /alpha/);
  });

  test('code is escaped, not interpreted', () => {
    const html = mdToHtml(`${F}\n<script>x</script> & <b>y</b>\n${F}\n`);
    assert.doesNotMatch(html, /<script/, 'a tag inside a code block must not reach the DOM as markup');
    assert.match(codeOf(html), /&lt;script&gt;/);
    assert.match(codeOf(html), /&amp;/);
  });
});

describe('markdown preview - tables', () => {
  const TABLE = '| # | Core Idea | Why It Matters |\n| --- | --- | --- |\n' +
                '| 1 | **Polymathy** beats narrow work. | AI lacks intuition. |\n' +
                '| 2 | Neuroscience | Better insight. |\n';

  test('a table renders with a header and one row per line', () => {
    const html = mdToHtml(TABLE);
    assert.equal(count(html, /<table/g), 1);
    assert.equal(count(html, /<th>/g), 3, 'three header cells');
    assert.equal(count(html, /<tr>/g), 3, 'a header row plus two body rows');
    assert.equal(count(html, /<td>/g), 6);
  });

  test('inline markup inside a cell is rendered', () => {
    const html = mdToHtml(TABLE);
    assert.match(html, /<(b|strong)>Polymathy<\/(b|strong)>/,
      'bold inside a table cell should be markup, not literal asterisks');
    assert.doesNotMatch(html, /\*\*/, 'asterisks leaked into the rendered table');
  });

  test('a table indented under a bullet still renders as a table', () => {
    const html = mdToHtml('- Leonardo\n\n' + TABLE.split('\n').map(l => l && '  ' + l).join('\n'));
    assert.equal(count(html, /<table/g), 1, `an indented table should still be a table:\n${html}`);
  });

  test('a code block and a table in one document both survive', () => {
    const html = mdToHtml(`# T\n\n- Tree\n  ${F}\n  a\n  b\n  ${F}\n- Table\n\n${TABLE}`);
    assert.equal(count(html, /<pre/g), 1, 'the code block went missing');
    assert.equal(count(html, /<table/g), 1, 'the table went missing');
    assert.equal(codeOf(html), 'a\nb');
  });
});

describe('markdown preview - frontmatter control blocks', () => {
  test('a mindspark block stays out of the Field | Value table', () => {
    const html = mdToHtml('---\ntitle: Doc\nmindspark:\n  layout: radial\n  style: neon\n---\n# Heading\n');
    assert.match(html, /<td>title<\/td><td>Doc<\/td>/);
    assert.doesNotMatch(html, /mindspark|radial|neon/);
    assert.match(html, /<h1>Heading<\/h1>/);
  });

  test('a frontmatter block holding only controls renders no empty table', () => {
    const html = mdToHtml('---\nmarkmap:\n  tree: org-chart\n---\n# Heading\n');
    assert.doesNotMatch(html, /<table/);
    assert.match(html, /<h1>Heading<\/h1>/);
  });
});
