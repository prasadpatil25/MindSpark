// Look config validation - the "I am" section's twin of style-config.
//
// A lookConfig is per-map user data (saved with the map and included in share
// links): whatever validateLookConfig returns must be complete and in range,
// and nothing it is given may make a map fail to render.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const DEFAULTS = extractConst('LOOK_CONFIG_DEFAULTS');
const BOUNDS = extractConst('LOOK_CONFIG_BOUNDS');
const { validateLookConfig, lookConfigFor } = loadFns(
  ['validateLookConfig', 'lookConfigFor'],
  { LOOK_CONFIG_DEFAULTS: DEFAULTS, LOOK_CONFIG_BOUNDS: BOUNDS }
);

const handwritten = raw => validateLookConfig(raw).handwritten;

describe('validateLookConfig - always returns something usable', () => {
  const junk = [
    ['null', null], ['undefined', undefined], ['a string', 'lab'],
    ['a number', 42], ['an array', [1, 2]], ['an empty object', {}],
    ['handwritten as a string', { handwritten: 'sketchy' }],
    ['handwritten as an array', { handwritten: [] }],
    ['an unknown look', { 'haunted-house': { radius: 5 } }],
  ];
  for (const [label, input] of junk) {
    test(`${label} yields the full defaults rather than throwing`, () => {
      assert.deepEqual(validateLookConfig(input), DEFAULTS);
    });
  }

  test('the result is always complete, so callers need no fallbacks', () => {
    const got = handwritten({ handwritten: { nodeSize: 1.3 } });
    for (const key of Object.keys(DEFAULTS.handwritten)) {
      assert.notEqual(got[key], undefined, `${key} missing from the result`);
    }
  });

  test('does not mutate the defaults object between calls', () => {
    validateLookConfig({ handwritten: { radius: 30 } });
    assert.equal(validateLookConfig(null).handwritten.radius, DEFAULTS.handwritten.radius);
  });

  test('does not mutate the input it was given', () => {
    const input = { handwritten: { nodeSize: 9 } };
    validateLookConfig(input);
    assert.equal(input.handwritten.nodeSize, 9, 'caller data must be left alone');
  });
});

describe('validateLookConfig - numeric knobs', () => {
  test('accepts an in-range value unchanged', () => {
    assert.equal(handwritten({ handwritten: { nodeSize: 1.2 } }).nodeSize, 1.2);
  });

  test('clamps above and below the allowed range instead of rejecting the config', () => {
    assert.equal(handwritten({ handwritten: { nodeSize: 0.1 } }).nodeSize, 0.8);
    assert.equal(handwritten({ handwritten: { nodeSize: 5 } }).nodeSize, 1.6);
    assert.equal(handwritten({ handwritten: { radius: -20 } }).radius, 0);
    assert.equal(handwritten({ handwritten: { radius: 999 } }).radius, 60);
  });

  test('fractions are kept, not rounded (nodeSize and radius are CSS units)', () => {
    assert.equal(handwritten({ handwritten: { nodeSize: 1.15 } }).nodeSize, 1.15);
    assert.equal(handwritten({ handwritten: { radius: 7.5 } }).radius, 7.5);
  });

  test('strings, booleans and NaN are ignored, not coerced', () => {
    const got = handwritten({ handwritten: { nodeSize: 'big', radius: true } });
    assert.equal(got.nodeSize, DEFAULTS.handwritten.nodeSize);
    assert.equal(got.radius, DEFAULTS.handwritten.radius);
  });

  test('unknown keys are dropped', () => {
    assert.deepEqual(handwritten({ handwritten: { wobble: 9 } }), DEFAULTS.handwritten);
  });
});

describe('validateLookConfig - font', () => {
  test('the default is the look\'s own CSS font, not an empty string', () => {
    assert.equal(DEFAULTS.handwritten.font, '"Caveat",cursive');
    assert.equal(DEFAULTS.lab.font, '"JetBrains Mono",monospace');
    assert.equal(DEFAULTS.office.font, '"Bricolage Grotesque",system-ui,sans-serif');
  });

  test('accepts a CSS font-family string', () => {
    assert.equal(handwritten({ handwritten: { font: '"Comic Sans MS",cursive' } }).font, '"Comic Sans MS",cursive');
  });

  test('an empty string keeps the look\'s own default font', () => {
    assert.equal(handwritten({ handwritten: { font: '' } }).font, DEFAULTS.handwritten.font);
  });

  test('is trimmed and capped at 60 characters', () => {
    const long = '"A very long font family name that goes on and on and on and on",cursive';
    assert.equal(handwritten({ handwritten: { font: '  ' + long + '  ' } }).font, long.slice(0, 60));
  });

  test('non-strings leave the default in place', () => {
    assert.equal(handwritten({ handwritten: { font: 42 } }).font, DEFAULTS.handwritten.font);
  });
});

describe('lookConfigFor - the dialog view', () => {
  test('returns only the requested look, with defaults merged in', () => {
    const got = lookConfigFor('coffee-shop', { 'coffee-shop': { nodeSize: 1.1 }, lab: { radius: 30 } });
    assert.deepEqual(got, { 'coffee-shop': { ...DEFAULTS['coffee-shop'], nodeSize: 1.1 } });
  });

  test('defaults when the look has no saved section', () => {
    assert.deepEqual(lookConfigFor('lab', null), { lab: DEFAULTS.lab });
  });

  test('each look keeps its own defaults', () => {
    assert.notEqual(DEFAULTS.handwritten.radius, DEFAULTS.lab.radius);
    assert.equal(DEFAULTS.handwritten.radius, 20);
    assert.equal(DEFAULTS.lab.radius, 4);
    assert.equal(DEFAULTS['coffee-shop'].radius, 18);
  });
});
// applyLookConfigVars() writes the active look's font/size/radius onto :root
// as inline custom properties. With no map open it used to return early, which
// left the LAST map's overrides in place - so the empty canvas after deleting
// the final map kept that map's font until the next load.
describe('applyLookConfigVars - no map means the look defaults, not the last map', () => {
  function harness() {
    const set = {}, removed = new Set();
    const root = {
      getAttribute: () => 'lab',
      style: {
        setProperty: (k, v) => { set[k] = v; removed.delete(k); },
        removeProperty: k => { delete set[k]; removed.add(k); },
      },
    };
    const state = { map: null };
    const fn = new Function('document', 'LOOK_CONFIG_DEFAULTS', 'state',
      `${extractFunction('applyLookConfigVars').replace(/\bmap\b/g, 'state.map')} return applyLookConfigVars;`)(
      { documentElement: root }, DEFAULTS, state);
    return { state, set, removed, apply: fn };
  }

  test('a map with a configured font sets it; closing the map puts the look default back', () => {
    const h = harness();
    h.state.map = { lookConfig: { lab: { font: '"Comic Sans MS"', nodeSize: 1.4, radius: 33 } } };
    h.apply();
    assert.equal(h.set['--sans'], '"Comic Sans MS"');
    assert.equal(h.set['--look-node-size'], 1.4);
    assert.equal(h.set['--look-radius'], '33px');
    h.state.map = null;
    h.apply();
    assert.equal(h.set['--sans'], DEFAULTS.lab.font, 'font back to the look default');
    assert.ok(h.removed.has('--look-node-size'), 'size override cleared');
    assert.ok(h.removed.has('--look-radius'), 'radius override cleared');
  });
});
