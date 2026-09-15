// Notes can hold $...$ / $$...$$ LaTeX, but the notes editor only ever showed
// the raw source. Now an expression renders IN PLACE the moment its closing $
// is typed (npRenderAtCaret), into an uneditable span that keeps the source in
// data-tex; clicking it, or Backspace right after it, gives the source back
// (npUnrender), and it renders again when the caret leaves (npRenderText).
// What is stored stays the $ source (npSerialize), as node text does, so notes
// remain editable and round-trip to Markdown. The DOM parts are verified in
// the browser; this pins the pure logic and the wiring.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction, loadFns, extractConst } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
const editor = extractFunction('showNotesEditor');
const MATH_DELIM_RE = extractConst('MATH_DELIM_RE');
const NP_MATH_AT_END = extractConst('NP_MATH_AT_END');
const { containsMath } = loadFns(['containsMath'], { MATH_DELIM_RE });
const ZW = '\u200B';

describe('NP_MATH_AT_END: the text before the caret ends in a complete expression', () => {
  const at = s => { const m = s.match(NP_MATH_AT_END); return m ? { tex: m[2] != null ? m[2] : m[3], display: m[2] != null } : null; };

  test('nothing until the closing $ is typed, then the inline expression', () => {
    assert.equal(at('Energy: $E = mc^2'), null);
    assert.deepEqual(at('Energy: $E = mc^2$'), { tex: 'E = mc^2', display: false });
  });

  test('$$x$ is a display expression still being typed, not inline $x$ with a stray $', () => {
    assert.equal(at(String.raw`and $$\frac{a}{b}$`), null, 'the moment after the first closing $');
    assert.deepEqual(at(String.raw`and $$\frac{a}{b}$$`), { tex: String.raw`\frac{a}{b}`, display: true });
  });

  test('only at the very end, and never money', () => {
    assert.equal(at('$x$ then more'), null, 'a formula further back was rendered when it was typed');
    assert.equal(at('costs $5 and $10 $'), null, 'a space inside the delimiters is not math');
    assert.deepEqual(at('after an anchor ' + ZW + '$y$'), { tex: 'y', display: false }, 'a caret anchor left in the text does not get in the way');
  });
});

describe('the delimiter scan shared with node text (containsMath / MATH_DELIM_RE)', () => {
  test('a closing $ is what completes an expression', () => {
    assert.equal(containsMath('Energy: $E = mc^2'), false);
    assert.equal(containsMath('Energy: $E = mc^2$'), true);
    assert.equal(containsMath(String.raw`$$\frac{a}{b}$$`), true);
    assert.equal(containsMath('costs $5 and $10'), false, 'a dollar followed or preceded by a space is money, not math');
    assert.equal(containsMath('no math'), false);
  });
});

describe('the rendered span and its source', () => {
  const { npMathSource } = loadFns(['npMathSource']);

  test('npMathSource puts the delimiters back around data-tex', () => {
    assert.equal(npMathSource({ dataset: { tex: 'E = mc^2', display: '0' } }), '$E = mc^2$');
    assert.equal(npMathSource({ dataset: { tex: String.raw`\frac{a}{b}`, display: '1' } }), String.raw`$$\frac{a}{b}$$`);
  });

  test('npRenderText splits one text node into text and spans, leaving what does not parse', () => {
    const made = [];
    const fakeDoc = {
      createDocumentFragment: () => ({ kids: [], appendChild(c) { this.kids.push(c); } }),
      createTextNode: v => ({ text: v }),
    };
    const { npRenderText } = loadFns(['npRenderText'], {
      containsMath, MATH_DELIM_RE, document: fakeDoc,
      npMathSpan: (tex, display) => { if (tex === 'bad') return null; const s = { tex, display }; made.push(s); return s; },
    });
    let replaced = null;
    const node = { nodeValue: 'a $x$ b $$y$$ c', parentNode: { replaceChild(frag, old) { replaced = { frag, old }; } } };
    assert.equal(npRenderText(node), 2);
    assert.equal(replaced.old, node);
    assert.deepEqual(replaced.frag.kids, [{ text: 'a ' }, { tex: 'x', display: false }, { text: ' b ' }, { tex: 'y', display: true }, { text: ' c' }]);

    replaced = null;
    assert.equal(npRenderText({ nodeValue: 'plain, $5 and $10', parentNode: { replaceChild() { replaced = true; } } }), 0);
    assert.equal(replaced, null, 'text without math is not touched at all');
    assert.equal(npRenderText({ nodeValue: 'see $bad$', parentNode: { replaceChild() { replaced = true; } } }), 0);
    assert.equal(replaced, null, 'an expression that does not parse stays as its source');
  });
});

describe('giving a formula its source back', () => {
  // A fake enough DOM for npUnrender: the span is replaced by a text node, and
  // the caret anchor that followed it (see npRenderAtCaret) goes too.
  const fakeDom = (nextValue) => {
    const range = { start: null, setStart(n, o) { this.start = [n, o]; }, collapse() {} };
    const sel = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges.push(r); } };
    const next = nextValue == null ? null : { nodeType: 3, nodeValue: nextValue, removed: false, remove() { this.removed = true; } };
    const document = { createTextNode: v => ({ nodeType: 3, nodeValue: v, nextSibling: next }), createRange: () => range };
    const { npUnrender } = loadFns(['npUnrender', 'npMathSource'], { document, getSelection: () => sel });
    return { npUnrender, range, sel, next };
  };
  const span = (tex, display) => ({ dataset: { tex, display: display ? '1' : '0' }, replaced: null, replaceWith(t) { this.replaced = t; } });

  test('inline: the source text node, caret just inside the closing $', () => {
    const d = fakeDom(null), sp = span('E = mc^2', false);
    const t = d.npUnrender(sp);
    assert.equal(sp.replaced, t);
    assert.equal(t.nodeValue, '$E = mc^2$');
    assert.deepEqual(d.range.start, [t, '$E = mc^2$'.length - 1]);
    assert.deepEqual(d.sel.ranges, [d.range]);
  });

  test('display: the caret lands before the two closing $', () => {
    const d = fakeDom(null), sp = span('y', true);
    const t = d.npUnrender(sp);
    assert.equal(t.nodeValue, '$$y$$');
    assert.deepEqual(d.range.start, [t, 3]);
  });

  test('the zero-width caret anchor after the formula is dropped, or its node removed when that was all of it', () => {
    let d = fakeDom(ZW + ' then more'); d.npUnrender(span('x', false));
    assert.equal(d.next.nodeValue, ' then more'); assert.equal(d.next.removed, false);
    d = fakeDom(ZW); d.npUnrender(span('x', false));
    assert.equal(d.next.removed, true);
    d = fakeDom('no anchor'); d.npUnrender(span('x', false));
    assert.equal(d.next.nodeValue, 'no anchor', 'ordinary following text is left alone');
  });

  test('npSpanBeforeCaret: a formula right before the caret, an anchor in between notwithstanding', () => {
    const formula = { nodeType: 1, classList: { contains: c => c === 'np-math' } };
    const ed = { contains: () => true };
    const sel = (anchorNode, anchorOffset) => ({ rangeCount: 1, isCollapsed: true, anchorNode, anchorOffset });
    const with_ = s => loadFns(['npSpanBeforeCaret'], { getSelection: () => s }).npSpanBeforeCaret(ed);
    assert.equal(with_(sel({ nodeType: 3, nodeValue: ZW + 'x', previousSibling: formula }, 1)), formula, 'caret after only the anchor');
    assert.equal(with_(sel({ nodeType: 3, nodeValue: 'ab', previousSibling: formula }, 0)), formula, 'caret at the start of the following text');
    assert.equal(with_(sel({ nodeType: 3, nodeValue: 'ab', previousSibling: formula }, 1)), null, 'a real character in between: Backspace deletes that');
    assert.equal(with_(sel({ nodeType: 1, childNodes: [formula] }, 1)), formula, 'caret in the element, right after the span');
    assert.equal(with_({ rangeCount: 1, isCollapsed: false, anchorNode: formula }), null, 'a selection is deleted as usual');
  });
});

describe('editor wiring', () => {
  test('saved $...$ renders on open; a keystroke renders what it just completed, but not after undo/redo', () => {
    assert.match(editor, /npRenderAll\(editor\);/);
    assert.match(editor, /editor\.addEventListener\('input', e=>\{ if\(!e\.isComposing && !\/\^history\/\.test\(e\.inputType\|\|''\)\) setTimeout\(\(\)=>npRenderAtCaret\(editor\), 0\); \}\);/);
  });

  test('click or Backspace onto a formula reopens its source; it renders again when the caret leaves', () => {
    assert.match(editor, /editor\.addEventListener\('click', e=>\{ const sp=e\.target\.closest\('\.np-math'\);[^\n]*editingNode=npUnrender\(sp\);/);
    assert.match(editor, /if\(e\.key==='Backspace'\)\{ const sp=npSpanBeforeCaret\(editor\); if\(sp\)\{ e\.preventDefault\(\); editingNode=npUnrender\(sp\); \} \}/);
    assert.match(editor, /document\.addEventListener\('selectionchange', onSel\);/);
    assert.match(editor, /const node=editingNode; editingNode=null;\r?\n\s*npRenderText\(node\);/);
    assert.match(editor, /const close=\(\)=>\{ document\.removeEventListener\('selectionchange', onSel\); popup\.remove\(\); \};/, 'the document listener does not outlive the popup');
  });

  test('saving stores the $ source through the notes sanitizer, never the MathML', () => {
    assert.match(editor, /const html=npSerialize\(editor\);/);
    const serialize = extractFunction('npSerialize');
    assert.match(serialize, /\.np-math'\)\.forEach\(sp=>sp\.replaceWith\(document\.createTextNode\(npMathSource\(sp\)\)\)\)/);
    assert.match(serialize, /return sanitizeNotes\(clone\.innerHTML\.replace\(\/\\u200B\/g,''\)\);/, 'caret anchors never reach the stored notes');
  });

  test('the rendered span is uneditable and carries its source; the caret anchor only when the formula ends the text', () => {
    const mk = extractFunction('npMathSpan');
    assert.match(mk, /span\.contentEditable='false';/);
    assert.match(mk, /span\.dataset\.tex=tex; span\.dataset\.display=display\?'1':'0';/);
    const at = extractFunction('npRenderAtCaret');
    assert.match(at, /const atEnd=end===node\.nodeValue\.length, anchor=atEnd\?'&#8203;':''/);
    assert.match(at, /document\.execCommand\('insertHTML', false, span\.outerHTML\+anchor\)/, 'through execCommand so the browser undo stack knows about the swap');
  });

  test('styles and placeholder', () => {
    assert.match(CSS, /\.notes-popup \.np-math\{/);
    assert.doesNotMatch(CSS, /\.np-preview/, 'the earlier preview strip is gone');
    assert.match(editor, /data-placeholder="[^"]*\$x\^2\$[^"]*"/);
  });
});

describe('the delimiter scan shared with node text (containsMath / MATH_DELIM_RE)', () => {
  test('a closing $ is what completes an expression', () => {
    assert.equal(containsMath('Energy: $E = mc^2'), false);
    assert.equal(containsMath('Energy: $E = mc^2$'), true);
    assert.equal(containsMath(String.raw`$$\frac{a}{b}$$`), true);
    assert.equal(containsMath('costs $5 and $10'), false, 'a dollar followed or preceded by a space is money, not math');
    assert.equal(containsMath('no math'), false);
  });
});

describe('the rendered span and its source', () => {
  const { npMathSource } = loadFns(['npMathSource']);

  test('npMathSource puts the delimiters back around data-tex', () => {
    assert.equal(npMathSource({ dataset: { tex: 'E = mc^2', display: '0' } }), '$E = mc^2$');
    assert.equal(npMathSource({ dataset: { tex: String.raw`\frac{a}{b}`, display: '1' } }), String.raw`$$\frac{a}{b}$$`);
  });

  test('npRenderText splits one text node into text and spans, leaving what does not parse', () => {
    const made = [];
    const fakeDoc = {
      createDocumentFragment: () => ({ kids: [], appendChild(c) { this.kids.push(c); } }),
      createTextNode: v => ({ text: v }),
    };
    const { npRenderText } = loadFns(['npRenderText'], {
      containsMath, MATH_DELIM_RE, document: fakeDoc,
      npMathSpan: (tex, display) => { if (tex === 'bad') return null; const s = { tex, display }; made.push(s); return s; },
    });
    let replaced = null;
    const node = { nodeValue: 'a $x$ b $$y$$ c', parentNode: { replaceChild(frag, old) { replaced = { frag, old }; } } };
    assert.equal(npRenderText(node), 2);
    assert.equal(replaced.old, node);
    assert.deepEqual(replaced.frag.kids, [{ text: 'a ' }, { tex: 'x', display: false }, { text: ' b ' }, { tex: 'y', display: true }, { text: ' c' }]);

    replaced = null;
    assert.equal(npRenderText({ nodeValue: 'plain, $5 and $10', parentNode: { replaceChild() { replaced = true; } } }), 0);
    assert.equal(replaced, null, 'text without math is not touched at all');
    assert.equal(npRenderText({ nodeValue: 'see $bad$', parentNode: { replaceChild() { replaced = true; } } }), 0);
    assert.equal(replaced, null, 'an expression that does not parse stays as its source');
  });
});

describe('giving a formula its source back', () => {
  // A fake enough DOM for npUnrender: the span is replaced by a text node, and
  // the caret anchor that followed it (see npRenderAtCaret) goes too.
  const fakeDom = (nextValue) => {
    const range = { start: null, setStart(n, o) { this.start = [n, o]; }, collapse() {} };
    const sel = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges.push(r); } };
    const next = nextValue == null ? null : { nodeType: 3, nodeValue: nextValue, removed: false, remove() { this.removed = true; } };
    const document = { createTextNode: v => ({ nodeType: 3, nodeValue: v, nextSibling: next }), createRange: () => range };
    const { npUnrender } = loadFns(['npUnrender', 'npMathSource'], { document, getSelection: () => sel });
    return { npUnrender, range, sel, next };
  };
  const span = (tex, display) => ({ dataset: { tex, display: display ? '1' : '0' }, replaced: null, replaceWith(t) { this.replaced = t; } });

  test('inline: the source text node, caret just inside the closing $', () => {
    const d = fakeDom(null), sp = span('E = mc^2', false);
    const t = d.npUnrender(sp);
    assert.equal(sp.replaced, t);
    assert.equal(t.nodeValue, '$E = mc^2$');
    assert.deepEqual(d.range.start, [t, '$E = mc^2$'.length - 1]);
    assert.deepEqual(d.sel.ranges, [d.range]);
  });

  test('display: the caret lands before the two closing $', () => {
    const d = fakeDom(null), sp = span('y', true);
    const t = d.npUnrender(sp);
    assert.equal(t.nodeValue, '$$y$$');
    assert.deepEqual(d.range.start, [t, 3]);
  });

  test('the zero-width caret anchor after the formula is dropped, or its node removed when that was all of it', () => {
    let d = fakeDom(ZW + ' then more'); d.npUnrender(span('x', false));
    assert.equal(d.next.nodeValue, ' then more'); assert.equal(d.next.removed, false);
    d = fakeDom(ZW); d.npUnrender(span('x', false));
    assert.equal(d.next.removed, true);
    d = fakeDom('no anchor'); d.npUnrender(span('x', false));
    assert.equal(d.next.nodeValue, 'no anchor', 'ordinary following text is left alone');
  });

  test('npSpanBeforeCaret: a formula right before the caret, an anchor in between notwithstanding', () => {
    const formula = { nodeType: 1, classList: { contains: c => c === 'np-math' } };
    const ed = { contains: () => true };
    const sel = (anchorNode, anchorOffset) => ({ rangeCount: 1, isCollapsed: true, anchorNode, anchorOffset });
    const with_ = s => loadFns(['npSpanBeforeCaret'], { getSelection: () => s }).npSpanBeforeCaret(ed);
    assert.equal(with_(sel({ nodeType: 3, nodeValue: ZW + 'x', previousSibling: formula }, 1)), formula, 'caret after only the anchor');
    assert.equal(with_(sel({ nodeType: 3, nodeValue: 'ab', previousSibling: formula }, 0)), formula, 'caret at the start of the following text');
    assert.equal(with_(sel({ nodeType: 3, nodeValue: 'ab', previousSibling: formula }, 1)), null, 'a real character in between: Backspace deletes that');
    assert.equal(with_(sel({ nodeType: 1, childNodes: [formula] }, 1)), formula, 'caret in the element, right after the span');
    assert.equal(with_({ rangeCount: 1, isCollapsed: false, anchorNode: formula }), null, 'a selection is deleted as usual');
  });
});

describe('editor wiring', () => {
  test('saved $...$ renders on open; a keystroke renders what it just completed, but not after undo/redo', () => {
    assert.match(editor, /npRenderAll\(editor\);/);
    assert.match(editor, /editor\.addEventListener\('input', e=>\{ if\(!e\.isComposing && !\/\^history\/\.test\(e\.inputType\|\|''\)\) setTimeout\(\(\)=>npRenderAtCaret\(editor\), 0\); \}\);/);
  });

  test('click or Backspace onto a formula reopens its source; it renders again when the caret leaves', () => {
    assert.match(editor, /editor\.addEventListener\('click', e=>\{ const sp=e\.target\.closest\('\.np-math'\);[^\n]*editingNode=npUnrender\(sp\);/);
    assert.match(editor, /if\(e\.key==='Backspace'\)\{ const sp=npSpanBeforeCaret\(editor\); if\(sp\)\{ e\.preventDefault\(\); editingNode=npUnrender\(sp\); \} \}/);
    assert.match(editor, /document\.addEventListener\('selectionchange', onSel\);/);
    assert.match(editor, /const node=editingNode; editingNode=null;\r?\n\s*npRenderText\(node\);/);
    assert.match(editor, /const close=\(\)=>\{ document\.removeEventListener\('selectionchange', onSel\); popup\.remove\(\); \};/, 'the document listener does not outlive the popup');
  });

  test('saving stores the $ source through the notes sanitizer, never the MathML', () => {
    assert.match(editor, /const html=npSerialize\(editor\);/);
    const serialize = extractFunction('npSerialize');
    assert.match(serialize, /\.np-math'\)\.forEach\(sp=>sp\.replaceWith\(document\.createTextNode\(npMathSource\(sp\)\)\)\)/);
    assert.match(serialize, /return sanitizeNotes\(clone\.innerHTML\.replace\(\/\\u200B\/g,''\)\);/, 'caret anchors never reach the stored notes');
  });

  test('the rendered span is uneditable and carries its source; the caret anchor only when the formula ends the text', () => {
    const mk = extractFunction('npMathSpan');
    assert.match(mk, /span\.contentEditable='false';/);
    assert.match(mk, /span\.dataset\.tex=tex; span\.dataset\.display=display\?'1':'0';/);
    const at = extractFunction('npRenderAtCaret');
    assert.match(at, /const atEnd=end===node\.nodeValue\.length, anchor=atEnd\?'&#8203;':''/);
    assert.match(at, /document\.execCommand\('insertHTML', false, span\.outerHTML\+anchor\)/, 'through execCommand so the browser undo stack knows about the swap');
  });

  test('styles and placeholder', () => {
    assert.match(CSS, /\.notes-popup \.np-math\{/);
    assert.doesNotMatch(CSS, /\.np-preview/, 'the earlier preview strip is gone');
    assert.match(editor, /data-placeholder="[^"]*\$x\^2\$[^"]*"/);
  });
});
