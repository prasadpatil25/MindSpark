// The Markdown preview passes raw HTML blocks through (tables, <details>,
// figures, the <img> buildMarkdown writes for a data: image) and scrubbed them
// with three regexes. The event-handler one needed WHITESPACE before "on", but
// a quote or slash ends an attribute just as well: <img src="x"onerror=...> is
// live HTML, and it sailed through. The image URL that fed it came from a node
// (shared link, import, live session) - safeImageUrl() only checked the prefix,
// and buildMarkdown() wrote the URL into src="..." unescaped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const { mdToHtml, scrubRawHtmlBlock } = loadFns(
  ['mdToHtml', 'stripIndent', 'scrubRawHtmlBlock', 'mdInlineToHtmlWithMath', 'renderMdList', 'mdInlineToHtml', 'escapeHtml',
   'parseMapOptionsFrontmatter', 'parseFrontmatterFields', 'frontmatterFieldsToHtml'],
  { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') });
const { safeImageUrl } = loadFns(['safeImageUrl'], { SAFE_IMAGE_RE: extractConst('SAFE_IMAGE_RE') });

// No event-handler attribute and no script-capable URL may survive.
const assertInert = (html, label) => {
  assert.doesNotMatch(html, /[\s"'\/]on[a-z]+\s*=/i, `${label}: an event handler survived:\n${html}`);
  assert.doesNotMatch(html, /(href|src|action|formaction)\s*=\s*["']?\s*(javascript|vbscript):/i, `${label}: a script URL survived:\n${html}`);
  assert.doesNotMatch(html, /<script/i, `${label}: a script tag survived:\n${html}`);
};

describe('raw HTML blocks in the preview are inert', () => {
  for (const [label, md] of [
    ['handler right after a quoted value', '<img src="x"onerror="alert(1)">'],
    ['handler after a single-quoted value', "<img src='x'onerror='alert(1)'>"],
    ['handler after a slash', '<img/onerror=alert(1) src=x>'],
    ['handler with a tab', '<img src=x\tonerror=alert(1)>'],
    ['handler inside a div block', '<div>\n<img src="x"onerror="alert(1)">\n</div>'],
    ['nested handler name', '<img src="x" oonerrornerror=alert(1)>'],
    ['the image buildMarkdown writes, under a bullet', '- node\n  <img src="data:image/png"onerror="alert(1)">'],
    ['unquoted javascript: href', '<div><a href=javascript:alert(1)>x</a></div>'],
    ['entity-encoded javascript: href', '<div><a href="&#106;avascript:alert(1)">x</a></div>'],
    ['hex-entity javascript: href', '<div><a href="&#x6A;avascript&#x3A;alert(1)">x</a></div>'],
    ['tab-split javascript: href', '<div><a href="java&#9;script:alert(1)">x</a></div>'],
    ['&colon; javascript href', '<div><a href="javascript&colon;alert(1)">x</a></div>'],
    ['upper-case scheme', '<div><a href="JaVaScRiPt:alert(1)">x</a></div>'],
    ['form action', '<div><form action="javascript:alert(1)"><button>go</button></form></div>'],
    ['formaction', '<div><button formaction=javascript:alert(1)>go</button></div>'],
    ['script inside a block', '<div><script>alert(1)</script></div>'],
    ['data:text/html link', '<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>'],
  ]) {
    test(label, () => {
      const html = mdToHtml(md);
      assertInert(html, label);
      if (/data:text/.test(md)) assert.doesNotMatch(html, /href="data:text/i);
    });
  }
});

describe('legitimate HTML blocks are unchanged', () => {
  for (const [label, block] of [
    ['a table', '<table><tr><th>A</th><td>1</td></tr></table>'],
    ['details/summary', '<details><summary>More</summary>body text about the only option</details>'],
    ['a figure with an https image', '<figure><img src="https://example.com/a.png" alt="a"></figure>'],
    ['a data: image', '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">'],
    ['an https link', '<p><a href="https://example.com/?a=1&amp;b=2" title="go on">link</a></p>'],
    ['a relative link', '<p><a href="#section">jump</a></p>'],
    ['text that mentions "on" and "src"', '<p>turn it on = off, the src is here</p>'],
  ]) {
    test(label, () => {
      assert.equal(scrubRawHtmlBlock(block), block);
      assert.ok(mdToHtml(block).includes(block), `mdToHtml changed the block:\n${mdToHtml(block)}`);
    });
  }
});

describe('node image URLs cannot break out of src="..."', () => {
  test('safeImageUrl refuses a quote and keeps every real image URL', () => {
    assert.equal(safeImageUrl('data:image/png"onerror="alert(1)'), null);
    assert.equal(safeImageUrl('https://a.example/x"onerror="alert(1)'), null);
    for (const ok of ['https://a.example/x.png?w=1&h=2', 'data:image/png;base64,iVBORw0KGgo=',
                      'blob:https://a.example/1234', "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"]) {
      assert.equal(safeImageUrl(ok), ok, ok);
    }
  });

  test('buildMarkdown and the document export escape the URL they write', () => {
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /<img src="\$\{n\.image\}"/, 'a node image is written into src="..." unescaped');
  });
});

// List items, paragraphs, headings, quotes and table cells go through
// mdInlineToHtml, which hands plain text back RAW (right for node text, which
// must keep "a < b" as typed). In the preview that raw text became DOM, so an
// <img onerror> needed no HTML block at all - one bullet was enough.
describe('inline preview text is inert too', () => {
  for (const [label, md] of [
    ['a paragraph', 'hello <img src=x onerror=alert(1)>'],
    ['a bullet', '- <img src="x"onerror="alert(1)">'],
    ['a heading', '# <img src=x onerror=alert(1)>'],
    ['a quote', '> <svg><animate attributeName=href to=javascript:alert(1) /></svg>'],
    ['a table cell', '| a |\n|---|\n| <img src=x onerror=alert(1)> |'],
  ]) {
    test(label, () => {
      const html = mdToHtml(md);
      assertInert(html, label);
      assert.doesNotMatch(html, /<animate/i, `${label}: <animate> survived`);
    });
  }

  test('the data: image buildMarkdown writes under a bullet still renders', () => {
    const img = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="pic">';
    assert.ok(mdToHtml('- node\n  ' + img + '\n').includes(img));
  });

  test('ordinary text is left exactly as it was', () => {
    assert.equal(mdToHtml('Turn the button onclick=go on'), '<p>Turn the button onclick=go on</p>');
    assert.equal(mdToHtml('- a < b and c > d'), '<ul><li>a < b and c > d</li></ul>');
  });

  test('the parser (node text) still gets plain text back untouched', () => {
    const { mdInlineToHtml } = loadFns(['mdInlineToHtml', 'scrubRawHtmlBlock', 'escapeHtml'],
      { INLINE_HTML_RE: extractConst('INLINE_HTML_RE') });
    assert.equal(mdInlineToHtml('a < b <img src=x onerror=y>'), 'a < b <img src=x onerror=y>');
  });
});
