// Chinese, Japanese and Korean input is COMPOSED: several keystrokes build a
// pre-edit string, a candidate window opens, and Enter / Escape / the arrow
// keys drive that window. They are the input method's keys during that window.
//
// A handler that acts on them anyway commits the pre-edit text - the raw pinyin
// the user has not confirmed yet - and tears the element down mid-composition.
// That was issue #39: "关闭自动修改在哪里，老是莫名其妙修改我输入的中文" -
// "where do I turn off auto-modify, it keeps inexplicably changing the Chinese I
// type". There was no auto-modify feature; the node editor was taking Enter
// away from the IME. It is worth knowing that the bug does not look like a
// missing guard to the person hitting it, it looks like a setting they cannot
// find - which is why this is enforced rather than left to review.
//
// A browser and a real input method are what actually prove this works. What is
// checkable here is the property that made it possible: a key handler that
// tests e.key without first asking whether a composition is open.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

const { isComposingKey } = loadFns(['isComposingKey']);

describe('isComposingKey', () => {
  test('detects a composing keydown both ways browsers report it', () => {
    // The spec answer, which Chromium and WebKit set correctly.
    assert.equal(isComposingKey({ key: 'Enter', isComposing: true }), true);
    // Firefox reports key:'Process' instead of the real key; keyCode 229 is the
    // one signal every engine sets. Checking only isComposing leaves it broken.
    assert.equal(isComposingKey({ key: 'Process', keyCode: 229 }), true);
    assert.equal(isComposingKey({ key: 'Enter', keyCode: 229 }), true);
  });

  test('a normal keypress is not composing', () => {
    assert.equal(isComposingKey({ key: 'Enter', isComposing: false, keyCode: 13 }), false);
    assert.equal(isComposingKey({ key: 'Escape', keyCode: 27 }), false);
    assert.equal(isComposingKey({ key: 'Enter' }), false);
    // Never throw on a synthetic or absent event - these handlers are hot paths.
    assert.equal(isComposingKey(null), false);
    assert.equal(isComposingKey(undefined), false);
  });
});

describe('every key handler yields to an open composition', () => {
  // Each place a keydown handler is installed. `pop._key` and the two `onKey`
  // closures are assigned rather than passed inline, so they are matched too.
  const STARTS = [
    /addEventListener\(\s*['"]keydown['"]\s*,/g,
    /pop\._key\s*=\s*e\s*=>/g,
    /const onKey\s*=\s*e\s*=>/g,
    /function presKey\s*\(/g,
  ];

  /** Where this handler first tests a key name - the point a guard must precede. */
  function firstKeyTest(slice) {
    const m = /\b(?:e|ev)\.key\s*(?:===|!==|==|!=)/.exec(slice);
    return m ? m.index : -1;
  }

  test('a guard, or a stated reason, precedes every key test', () => {
    const seen = [];
    for (const re of STARTS) {
      for (const m of APP.matchAll(re)) {
        // A generous window: every handler here reaches its first key test well
        // inside this, and overshooting only makes the test stricter.
        const slice = APP.slice(m.index, m.index + 1200);
        const at = firstKeyTest(slice);
        if (at === -1) continue;                    // no key test: nothing to steal
        const before = slice.slice(0, at);
        const line = APP.slice(0, m.index).split('\n').length;
        seen.push(line);
        const guarded = before.includes('isComposingKey');
        const exempt = before.includes('ime-exempt:');
        assert.ok(guarded || exempt,
          `public/app.js:${line} tests e.key without first calling isComposingKey(e).\n` +
          `Add the guard, or an "// ime-exempt: <why>" comment if a composition genuinely cannot be open.\n` +
          `Handler starts:\n${slice.slice(0, 220)}`);
      }
    }
    // If this drops to a handful, the regexes above have stopped matching the
    // code rather than the code having become clean.
    assert.ok(seen.length >= 20, `expected to inspect the whole app; only found ${seen.length} key handlers`);
  });

  test('the node editor guards before it can commit or revert', () => {
    // The reported bug, pinned exactly: Enter committed the pre-edit text and
    // Escape reverted the node, both while the composition was still open.
    const at = APP.indexOf('const onKey=e=>', APP.indexOf('function startEdit('));
    const body = APP.slice(at, APP.indexOf('textEl.addEventListener(\'blur\',onBlur)', at));
    assert.ok(body.indexOf('isComposingKey') < body.indexOf("e.key==='Enter'"),
      'the composition guard must come before the Enter commit');
    assert.ok(body.indexOf('isComposingKey') < body.indexOf("e.key==='Escape'"),
      'the composition guard must come before the Escape revert');
    // formulaAutocompleteKeydown runs first and eats ArrowUp/ArrowDown, which is
    // how a candidate list is paged, so it needs its own guard rather than
    // relying on the caller's.
    const ac = APP.slice(APP.indexOf('function formulaAutocompleteKeydown'));
    const acBody = ac.slice(0, ac.indexOf('\n}'));
    assert.ok(acBody.indexOf('isComposingKey') < acBody.indexOf("e.key==='ArrowDown'"),
      'the autocomplete popup must not race the IME for the arrow keys');
  });

  test('input-driven DOM rewrites wait for the composition to end', () => {
    // tryMarkdownShortcut() calls parent.replaceChild() on the very text node
    // being composed into. Running it mid-composition destroys the composition,
    // so onInput skips it and compositionend makes the work up afterwards.
    const at = APP.indexOf('const onInput=', APP.indexOf('function startEdit('));
    const body = APP.slice(at, at + 900);
    assert.match(body, /if\(!\(e && e\.isComposing\)\)\{/,
      'onInput must not rewrite the DOM while a composition is open');
    // Match the call statement, not the mention of it in the comment above.
    assert.ok(body.indexOf('e.isComposing') < body.indexOf('tryMarkdownShortcut();'),
      'the composition check must precede the markdown rewrite');
    assert.ok(body.indexOf('e.isComposing') < body.indexOf('updateFormulaAutocomplete(textEl, id);'),
      'the composition check must precede the autocomplete update');
    assert.match(APP, /textEl\.addEventListener\('compositionend',onCompositionEnd\)/,
      'the skipped work must be made up when the composition ends');
    assert.match(APP, /textEl\.removeEventListener\('compositionend',onCompositionEnd\)/,
      'and the listener must come off with the others, or it leaks per edit');
  });
});
