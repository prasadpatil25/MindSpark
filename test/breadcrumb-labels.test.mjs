// What each breadcrumb crumb says.
//
// The crumb used to be nodeTextPlain(text) cut at 22 characters, escaped. Two
// things followed from that. A node titled with LaTeX showed its source
// ("$E=mc^2$") while the canvas showed the formula. And a block node - a table,
// a code block, raw HTML, a divider - has no words of its own: its text is a
// placeholder or empty, so its crumb read "table" or "(untitled)", and two
// tables on one path looked identical. crumbLabel names the kind and what sets
// one apart; crumbHtml renders the math. The table / code / raw HTML branches
// parse through a <template> and are checked in a real browser; the branches
// below need no DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const { crumbHtml, crumbLabel } = loadFns(
  ['crumbHtml', 'crumbLabel', 'containsMath', 'latexToMathML', '_mathEsc', 'escapeHtml'],
  { MATH_DELIM_RE: extractConst('MATH_DELIM_RE'), nodeTextPlain: t => t.replace(/<[^>]+>/g, '') });

describe('breadcrumb - LaTeX', () => {
  test('inline math renders as MathML, not as its source', () => {
    const html = crumbHtml('Energy $E=mc^2$', true);
    assert.match(html, /^Energy <math\b/, html);
    assert.match(html, /<msup>/, 'the superscript was not converted');
    assert.doesNotMatch(html, /\$/, 'a dollar delimiter leaked into the crumb');
  });

  test('display math is drawn inline, since a crumb is one line', () => {
    const html = crumbHtml('$$x^2$$', true);
    assert.match(html, /^<math\b/);
    assert.doesNotMatch(html, /display="block"/);
  });

  test('a label holding math is not cut, so no formula is split in half', () => {
    const label = 'A rather long node title with $\\frac{a}{b}$ at the end';
    const html = crumbHtml(label, true);
    assert.match(html, /<mfrac>/);
    assert.doesNotMatch(html, /…/, 'cut despite the math; CSS bounds this crumb instead');
  });

  test('text around the math is still escaped', () => {
    assert.match(crumbHtml('<b>x</b> $y$', true), /^&lt;b&gt;x&lt;\/b&gt; <math\b/);
  });

  test('a label with no math is cut at 22 characters as before', () => {
    assert.equal(crumbHtml('abcdefghijklmnopqrstuvwxyz', true), 'abcdefghijklmnopqrstuv…');
    assert.equal(crumbHtml('a < b', true), 'a &lt; b');
  });

  test('prices and shell variables are not taken for math when math is off', () => {
    assert.equal(crumbHtml('echo $HOME$PATH', false), 'echo $HOME$PATH');
  });
});

describe('breadcrumb - block nodes', () => {
  test('a divider is named, not "(untitled)"', () => {
    assert.deepEqual(crumbLabel({ hr: true, text: '' }), { text: 'Divider', math: false });
  });

  test('the frontmatter node is named', () => {
    assert.equal(crumbLabel({ frontmatter: true, html: '<table></table>' }).text, 'Frontmatter');
  });

  test('an ordinary node keeps its text, with math on', () => {
    assert.deepEqual(crumbLabel({ text: '<b>Bold</b> $x$' }), { text: 'Bold $x$', math: true });
  });

  test('updateBreadcrumb builds every crumb from these two', () => {
    const src = extractFunction('updateBreadcrumb');
    assert.match(src, /crumbLabel\(map\.nodes\[id\]\)/);
    assert.match(src, /crumbHtml\(label, lab\.math\)/);
    assert.doesNotMatch(src, /escapeHtml\(short\)/, 'the old plain-text crumb is back');
  });
});
