// app.js is one classic script, so `const` and `let` declarations are in their
// temporal dead zone until the line that declares them runs - and function
// declarations are hoisted above all of that. A hoisted function that reads a
// later const, called at script-evaluation time, throws ReferenceError. That
// happened to applyLook(): its effect-layer helper read LOOK_FX, declared near
// the end of the file, and the boot call sat inside an empty catch, so the
// error was swallowed on every load and only a second sync at the very end
// made the layer appear. These checks keep the declarations ahead of the call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const at = (needle) => { const i = APP.indexOf(needle); assert.notEqual(i, -1, 'not found: ' + needle); return i; };

describe('boot-time look application', () => {
  const boot = at("applyLook(localStorage.getItem('mindspark:look')");

  test('every binding the effect layer reads is declared before the boot call', () => {
    for (const decl of ['const LOOK_FX', 'let _fxEl', 'function _syncLookFx(', 'function applyLook(', 'const LOOKS = [', 'const GROOT_FACE']) {
      assert.ok(at(decl) < boot, decl + ' must come before the boot-time applyLook()');
    }
  });

  test('the boot call does not hide a failure', () => {
    const line = APP.slice(boot, APP.indexOf('\n', boot));
    assert.doesNotMatch(line, /catch\(e\)\{\s*\}/, 'an empty catch here hid a ReferenceError on every load');
    assert.match(line, /console\.warn/);
  });

  test('the effect layer is not synced a second time at the end of the file', () => {
    const last = APP.lastIndexOf('_syncLookFx();');
    assert.ok(last < boot, 'the boot applyLook() is the one place the layer is synced at load');
  });
});
