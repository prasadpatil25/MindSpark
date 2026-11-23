// Three places where text from outside the app became markup:
//  - the word of the day: third-party API JSON went into innerHTML;
//  - Markdown preview links: [x](url) became <a href="url"> guarded only by a
//    single-pass .replace(/javascript:/gi,'') - "javajavascript:script:" and
//    "java<TAB>script:" walked through it (and it mangled ordinary text);
//  - stored templates / shared-map rows (written by a preferences import):
//    colour and icon were concatenated into innerHTML unescaped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const { mdToHtml, safeLinkHref } = loadFns(
  ['mdToHtml', 'stripIndent', 'safeLinkHref', 'scrubRawHtmlBlock', 'mdInlineToHtmlWithMath', 'renderMdList', 'mdInlineToHtml',
   'escapeHtml', 'parseFrontmatterFields', 'frontmatterFieldsToHtml'],
  { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') });

describe('word of the day is text, never markup', () => {
  test('the renderer assigns textContent and builds the part-of-speech span', () => {
    const body = SRC.slice(SRC.indexOf('function _qotdRender('), SRC.indexOf('async function _qotdFetch('));
    assert.doesNotMatch(body, /word\.innerHTML/);
    assert.match(body, /word\.textContent\s*=\s*q\.word/);
    assert.match(body, /sp\.textContent\s*=\s*q\.part/);
  });
});

describe('Markdown preview links', () => {
  for (const [label, md] of [
    ['nested strip bypass', '- [x](javajavascript:script:alert%281%29)'],
    ['tab inside the scheme', '- [x](java\tscript:alert%281%29)'],
    ['upper case', 'see [x](JAVASCRIPT:alert%281%29)'],
    ['vbscript', '- [x](vbscript:msgbox)'],
    ['data:text/html', '- [x](data:text/html,hi)'],
  ]) {
    test(`${label} is not a link`, () => {
      const html = mdToHtml(md);
      assert.doesNotMatch(html, /<a\s/i, html);
      assert.match(html, /x/);
    });
  }
  test('ordinary links still work', () => {
    for (const url of ['https://example.com/a?b=1', 'http://x.io', 'mailto:me@example.com', '#section', 'docs/page.md', '/abs/path']) {
      assert.match(mdToHtml(`- [go](${url})`), /<a href="/, url);
      assert.equal(safeLinkHref(url), true, url);
    }
  });
  test('text that mentions javascript: is left alone', () => {
    assert.match(mdToHtml('Use `javascript:void 0` sparingly'), /javascript:void 0/);
  });
});

describe('template and shared-map rows escape what they interpolate', () => {
  test('no raw colour/icon concatenation in the sinks a preferences import can reach', () => {
    assert.doesNotMatch(SRC, /style="background:'\+\(sm\.color/);
    assert.doesNotMatch(SRC, /style="background:\$\{t\.color\}">\$\{t\.icon/);
    assert.doesNotMatch(SRC, /style="background:'\+\(t\.color\|\|c\.color\)\+'">'\+\(t\.icon/);
    assert.doesNotMatch(SRC, /style="background:'\+\(item\.color/);
    assert.doesNotMatch(SRC, /style="color:'\+\(t\.color\|\|c\.color\)\+'"/);
    assert.doesNotMatch(SRC, /style="color:'\+c\.color\+'"/);
  });
});
