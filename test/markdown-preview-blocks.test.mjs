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
// Tables had the same bug and it went unnoticed, because the table test put a
// blank line between the bullet and the table, which ends the list before the
// scanner can swallow anything. buildMarkdown writes no blank line there, so a
// table node under a bullet came out of the preview as one bullet per row. The
// fence fix had also only stopped the list at the fence, so the code landed
// after the list instead of inside the item it belongs to. The tests below use
// the exact shape buildMarkdown writes and check where each block lands.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const { mdToHtml } = loadFns(
  ['mdToHtml', 'stripIndent', 'scrubRawHtmlBlock', 'mdInlineToHtmlWithMath', 'renderMdList', 'mdInlineToHtml', 'escapeHtml',
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

describe('markdown preview - blocks nested under a bullet, as buildMarkdown writes them', () => {
  const ind = (s, n) => s.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');
  const TABLE = '| # | Core Idea |\n| --- | --- |\n| 1 | **Polymathy** |\n| 2 | Neuroscience |';
  // The item's own text, then whatever block html follows it inside the same <li>.
  const liBody = (html, text) => {
    const at = html.indexOf('<li>' + text);
    assert.notEqual(at, -1, `no item "${text}":\n${html}`);
    return html.slice(at);
  };

  // The ToDo's map that reported this: a table node under "Leonardo Da Vinci",
  // itself a child bullet, with a sibling after it. No blank lines anywhere.
  const LEO = `- Ideas\n  - Leonardo Da Vinci\n${ind(TABLE, 4)}\n  - 369!\n- Random Thoughts\n`;

  test('a table under a child bullet is one table, not one bullet per row', () => {
    const html = mdToHtml(LEO);
    assert.equal(count(html, /<table/g), 1, `expected one table:\n${html}`);
    assert.equal(count(html, /<td>/g), 4);
    assert.doesNotMatch(html, /<li>[^<]*\|/, 'a table row leaked out as a list item');
    assert.equal(count(html, /<li>/g), 4, 'Ideas, Leonardo, 369! and Random Thoughts, nothing else');
  });

  test('the table sits inside its own item, and the list carries on after it', () => {
    const html = mdToHtml(LEO);
    assert.match(liBody(html, 'Leonardo Da Vinci'), /^<li>Leonardo Da Vinci<table/, 'the table must follow its item, inside it');
    assert.match(html, /<\/table><\/li><li>369!<\/li>/, '369! stays the next sibling in the same list');
  });

  const F3 = '```';
  for (const [kind, block, tag, expect] of [
    ['code block', `${F3}\nroot\n|  +- leaf\n${F3}`, 'pre', /<pre class="mp-code"><code>root\n\|  \+- leaf<\/code><\/pre>/],
    ['blockquote (a node\'s notes)', '> a note', 'blockquote', /<blockquote>a note<\/blockquote>/],
    ['raw HTML block', '<details><summary>More</summary>\n<p>Body</p>\n</details>', 'details', /<details><summary>More<\/summary>\n<p>Body<\/p>\n<\/details>/],
    ['image', '![diagram](https://example.com/a.png)', 'img', /<img alt="diagram" src="https:\/\/example.com\/a.png">/],
    ['divider', '---', 'hr', /<hr>/],
    ['paragraph node', 'A plain paragraph.', 'p', /<p>A plain paragraph.<\/p>/],
  ]) {
    test(`a ${kind} under a child bullet renders inside that item`, () => {
      const html = mdToHtml(`- Parent\n  - Child\n${ind(block, 4)}\n  - Next\n`);
      assert.match(html, expect, `the ${kind} did not render:\n${html}`);
      assert.match(liBody(html, 'Child'), new RegExp(`^<li>Child<${tag}\\b`), `the ${kind} is not inside its item:\n${html}`);
      assert.equal(count(html, /<li>/g), 3, `stray list items:\n${html}`);
    });
  }

  test('a deeper bullet after a block still hangs off the item, not the block', () => {
    const html = mdToHtml(`- Parent\n${ind(TABLE, 2)}\n  - Kid\n- Next\n`);
    assert.match(html, /<li>Parent<table[\s\S]*<\/table><ul><li>Kid<\/li><\/ul><\/li><li>Next<\/li>/, html);
  });

  test('a block under the top-level bullet of a heading section renders the same way', () => {
    const html = mdToHtml(`# ToDo's\n\n## Section\n\n- Item\n${ind(TABLE, 2)}\n`);
    assert.match(html, /<h2>Section<\/h2>/);
    assert.match(html, /<li>Item<table/);
  });

  test('a block directly under a heading (no bullet) renders at the top level', () => {
    const html = mdToHtml(`# Root\n\n${TABLE}\n\n${F3}\nx\n${F3}\n`);
    assert.equal(count(html, /<table/g), 1);
    assert.equal(count(html, /<pre/g), 1);
    assert.equal(count(html, /<li>/g), 0);
  });

  test('raw HTML under a bullet is still scrubbed', () => {
    const html = mdToHtml('- Item\n  <div onclick="x()"><a href="javascript:alert(1)">a</a></div>\n');
    assert.doesNotMatch(html, /onclick|javascript:/);
    assert.match(html, /<li>Item<div/);
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
