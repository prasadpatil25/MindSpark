// Theme config validation - the "Colour theme" section's twin of look-config.
//
// A themeConfig is per-map user data (saved with the map and included in
// share links): whatever validateThemeConfig returns must be complete and in
// range, and nothing it is given may make a map fail to render.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const DEFAULTS = extractConst('THEME_CONFIG_DEFAULTS');
const BOUNDS = extractConst('THEME_CONFIG_BOUNDS');
const VARS = extractConst('THEME_CONFIG_VARS');
// No custom theme imported here: the custom section appears only while one exists (theme-config-custom.test.mjs).
const { validateThemeConfig, themeConfigFor } = loadFns(
  ['validateThemeConfig', 'themeConfigFor', 'themeConfigDefaults'],
  { THEME_CONFIG_DEFAULTS: DEFAULTS, THEME_CONFIG_BOUNDS: BOUNDS, THEME_CONFIG_VARS: VARS, THEME_CONFIG_PALETTE: { ...VARS, nodeBg: '--node-bg' }, loadCustomTheme: () => null }
);

const dracula = raw => validateThemeConfig(raw).dracula;

describe('validateThemeConfig - always returns something usable', () => {
  const junk = [
    ['null', null], ['undefined', undefined], ['a string', 'dark'],
    ['a number', 42], ['an array', [1, 2]], ['an empty object', {}],
    ['dracula as a string', { dracula: 'spooky' }],
    ['dracula as an array', { dracula: [] }],
    ['an unknown theme', { 'no-such-theme': { ink: '#fff' } }],
  ];
  for (const [label, input] of junk) {
    test(`${label} yields the full defaults rather than throwing`, () => {
      assert.deepEqual(validateThemeConfig(input), DEFAULTS);
    });
  }

  test('the result is always complete, so callers need no fallbacks', () => {
    const got = dracula({ dracula: { ink: '#123456' } });
    for (const key of Object.keys(DEFAULTS.dracula)) {
      assert.notEqual(got[key], undefined, `${key} missing from the result`);
    }
  });

  test('does not mutate the defaults object between calls', () => {
    validateThemeConfig({ dracula: { paper: '#000000' } });
    assert.equal(validateThemeConfig(null).dracula.paper, DEFAULTS.dracula.paper);
  });

  test('does not mutate the input it was given', () => {
    const input = { dracula: { accent: '#ffffff' } };
    validateThemeConfig(input);
    assert.equal(input.dracula.accent, '#ffffff', 'caller data must be left alone');
  });
});

describe('validateThemeConfig - colours', () => {
  test('each theme defaults to the colours its own CSS block declares', () => {
    assert.equal(DEFAULTS.light.paper, '#f4efe6');
    assert.equal(DEFAULTS.light.ink, '#23201b');
    assert.equal(DEFAULTS.dark.paper, '#1e1e1e');
    assert.equal(DEFAULTS.dark.accent, '#3794ff');
    assert.equal(DEFAULTS.dracula.paper, '#282a36');
    assert.equal(DEFAULTS.nord.nodeBg, '#434c5e');
  });

  test('accepts a CSS colour string', () => {
    assert.equal(dracula({ dracula: { accent: '#ff00ff' } }).accent, '#ff00ff');
    assert.equal(dracula({ dracula: { glow: 'rgba(1,2,3,.5)' } }).glow, 'rgba(1,2,3,.5)');
  });

  test('an empty string keeps the theme\'s own colour', () => {
    assert.equal(dracula({ dracula: { ink: '' } }).ink, DEFAULTS.dracula.ink);
  });

  test('is trimmed and capped at 40 characters', () => {
    const long = 'color(display-p3 1 0 0 / 1)'.repeat(3);
    assert.equal(dracula({ dracula: { paper: '  ' + long + '  ' } }).paper, long.slice(0, 40));
  });

  test('non-strings leave the default in place', () => {
    const got = dracula({ dracula: { ink: 42, line: true, glow: null } });
    assert.equal(got.ink, DEFAULTS.dracula.ink);
    assert.equal(got.line, DEFAULTS.dracula.line);
    assert.equal(got.glow, DEFAULTS.dracula.glow);
  });

  test('unknown keys are dropped', () => {
    assert.deepEqual(dracula({ dracula: { shimmer: '#fff' } }), DEFAULTS.dracula);
  });
});

describe('themeConfigFor - the dialog view', () => {
  test('returns only the requested theme, with defaults merged in', () => {
    const got = themeConfigFor('dark', { dark: { paper: '#111111' }, light: { paper: '#eeeeee' } });
    assert.deepEqual(got, { dark: { ...DEFAULTS.dark, paper: '#111111' } });
  });

  test('defaults when the theme has no saved section', () => {
    assert.deepEqual(themeConfigFor('nord', null), { nord: DEFAULTS.nord });
  });

  test('the light theme is the implicit default and has its own palette', () => {
    assert.deepEqual(themeConfigFor('light', null), { light: DEFAULTS.light });
    assert.notEqual(DEFAULTS.light.paper, DEFAULTS.dark.paper);
  });
});