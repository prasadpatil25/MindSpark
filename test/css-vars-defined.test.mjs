// Every custom property styles.css reads must resolve to something.
//
// `background:var(--bg)` with no fallback and no declaration anywhere is not a
// no-op: the whole declaration becomes invalid at computed-value time, so the
// property falls back to `unset` and the element paints nothing. That is how
// the build-prompt textarea, the DOI field and the custom-marker input ended
// up transparent instead of recessed - a dead name (`--bg`, `--paper-1`) that
// no theme has ever declared.
//
// A property written from script is fine, but only if the sheet says so: it
// must either carry a fallback, or be listed below with where JS sets it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CSS } from './helpers/css-audit.mjs';

// Set from JS, never from the sheet. The value is the proof: grep it.
const SET_FROM_SCRIPT = {
  '--p-color': 'inline on .donate-provider, app.js renderDonateProviders',
  '--look-radius': "root.style.setProperty('--look-radius', ...) in applyLookConfigVars; " +
                   'every use is guarded by .user-look-radius',
  '--tt-w': "el.style.setProperty('--tt-w', cell.w+'px') in the render tree-table cell pass",
  '--tt-h': "el.style.setProperty('--tt-h', cell.h+'px') in the render tree-table cell pass",
};

function declaredNames(css) {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
}
// name -> true while every single use carries a fallback
function usedNames(css) {
  const out = new Map();
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    const [, name, comma] = m;
    out.set(name, (out.has(name) ? out.get(name) : true) && !!comma);
  }
  return out;
}

describe('custom properties resolve', () => {
  const declared = declaredNames(CSS);
  const used = usedNames(CSS);

  test('the scan sees the sheet', () => {
    assert.ok(declared.has('--paper') && used.has('--paper'), 'the custom-property scan found nothing');
  });

  test('no declaration reads a name that is never defined and has no fallback', () => {
    const dead = [...used]
      .filter(([name, everyUseHasFallback]) => !declared.has(name) && !everyUseHasFallback)
      .map(([name]) => name)
      .filter(name => !(name in SET_FROM_SCRIPT));
    assert.deepEqual(dead, [],
      'these names are read with no fallback and never declared, so the declarations using them\n' +
      'are dropped and the element paints nothing. Declare them, give them a fallback, or add them\n' +
      'to SET_FROM_SCRIPT with the line of JS that sets them:\n  ' + dead.join('\n  '));
  });

  test('the script-set exemptions are still script-set', () => {
    for (const [name, why] of Object.entries(SET_FROM_SCRIPT)) {
      assert.ok(used.has(name), `${name} is exempted but no longer used - drop the exemption (${why})`);
      assert.ok(!declared.has(name),
        `${name} is declared in styles.css now, so the exemption is stale (${why})`);
    }
  });
});
