// "Colour theme settings" showed "{}" for an imported custom theme, and could
// not save anything for it: validateThemeConfig() built its sections from
// THEME_CONFIG_DEFAULTS alone, which has no "custom" entry, so the custom
// theme's section was neither offered nor kept. The custom theme is now a
// section like any other while it exists, its defaults read from its own
// palette (the node swatch through THEME_CONFIG_PALETTE), and it is dropped
// again once the theme is removed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const DEFAULTS = extractConst('THEME_CONFIG_DEFAULTS');
const BOUNDS = extractConst('THEME_CONFIG_BOUNDS');
const VARS = extractConst('THEME_CONFIG_VARS');
const PALETTE = { ...VARS, nodeBg: '--node-bg' };
const CUSTOM_THEME_VARS = extractConst('CUSTOM_THEME_VARS');

const glass = {
  v: 1, id: 'glass', name: 'Glass',
  vars: Object.fromEntries(CUSTOM_THEME_VARS.map(k => [k, ({ '--paper': '#101010', '--ink': '#eeeeee', '--accent': '#ff00aa', '--node-bg': '#ffffff80', '--line': '#333333', '--stage-glow': 'rgba(255,0,170,.06)' })[k] || '#000000'])),
};
const withTheme = theme => loadFns(
  ['validateThemeConfig', 'themeConfigFor', 'themeConfigDefaults', 'themeConfigOverrides'],
  { THEME_CONFIG_DEFAULTS: DEFAULTS, THEME_CONFIG_BOUNDS: BOUNDS, THEME_CONFIG_VARS: VARS, THEME_CONFIG_PALETTE: PALETTE, loadCustomTheme: () => theme }
);

describe('the custom theme has a settings section while it exists', () => {
  test('its defaults are its own palette, the node swatch included', () => {
    const { themeConfigDefaults } = withTheme(glass);
    assert.deepEqual(themeConfigDefaults('custom'), {
      paper: '#101010', ink: '#eeeeee', accent: '#ff00aa', nodeBg: '#ffffff80', line: '#333333', glow: 'rgba(255,0,170,.06)',
    });
    assert.equal(themeConfigDefaults('dracula'), DEFAULTS.dracula, 'built-ins are unchanged');
    assert.equal(themeConfigDefaults('no-such-theme'), null);
  });

  test('the settings dialog gets a full section for it, not {}', () => {
    const { themeConfigFor } = withTheme(glass);
    assert.deepEqual(themeConfigFor('custom', null), { custom: { paper: '#101010', ink: '#eeeeee', accent: '#ff00aa', nodeBg: '#ffffff80', line: '#333333', glow: 'rgba(255,0,170,.06)' } });
  });

  test('a tuned knob is kept on top of the palette, and the other themes are untouched', () => {
    const { validateThemeConfig, themeConfigFor } = withTheme(glass);
    const raw = { custom: { ink: '#ff0000' }, dracula: { ink: '#123456' } };
    assert.deepEqual(themeConfigFor('custom', raw).custom, { ...themeConfigFor('custom', null).custom, ink: '#ff0000' });
    assert.equal(validateThemeConfig(raw).dracula.ink, '#123456');
    assert.equal(Object.keys(validateThemeConfig(raw)).length, Object.keys(DEFAULTS).length + 1);
  });

  test('without a custom theme nothing changes: no section, and a stale one is dropped', () => {
    const { validateThemeConfig, themeConfigFor, themeConfigDefaults } = withTheme(null);
    assert.equal(themeConfigDefaults('custom'), null);
    assert.deepEqual(themeConfigFor('custom', { custom: { ink: '#ff0000' } }), {});
    assert.deepEqual(validateThemeConfig({ custom: { ink: '#ff0000' } }), DEFAULTS);
  });
});

describe('what gets stored is the difference from the theme, not the resolved section', () => {
  // Storing the full resolved section froze the palette of the moment onto the
  // custom slot: importing another theme kept the previous canvas colour until
  // "Reset to defaults". Only tuned knobs are stored now.
  test('a section equal to the palette stores nothing', () => {
    const { themeConfigOverrides, themeConfigFor } = withTheme(glass);
    assert.equal(themeConfigOverrides('custom', themeConfigFor('custom', null).custom), null);
    assert.equal(themeConfigOverrides('dracula', { ...DEFAULTS.dracula }), null);
  });
  test('only the tuned knobs are kept; blanks and non-strings never are', () => {
    const { themeConfigOverrides } = withTheme(glass);
    assert.deepEqual(themeConfigOverrides('custom', { paper: '#101010', ink: '#ff0000', accent: '', line: 3 }), { ink: '#ff0000' });
    assert.deepEqual(themeConfigOverrides('dracula', { ...DEFAULTS.dracula, paper: '#123456' }), { paper: '#123456' });
  });
  test('the dialog stores through it and drops an emptied section', () => {
    const src = extractFunction('showThemeConfigForm');
    assert.match(src, /const diff = themeConfigOverrides\(t, sec\);\r?\n\s*if\(diff\) next\[t\] = diff; else delete next\[t\];/);
    assert.match(src, /if\(Object\.keys\(next\)\.length\) map\.themeConfig = next; else delete map\.themeConfig;/);
  });
});

describe('wiring', () => {
  test('applyThemeConfigVars starts from the same defaults, light when the theme is gone', () => {
    const src = extractFunction('applyThemeConfigVars');
    assert.match(src, /const defaults = themeConfigDefaults\(theme\) \|\| THEME_CONFIG_DEFAULTS\.light;/);
  });
  test('the dialog title names the custom theme', () => {
    const src = extractFunction('showThemeConfigForm');
    assert.match(src, /\(theme==='custom'&&loadCustomTheme\(\)\)/);
  });
});
