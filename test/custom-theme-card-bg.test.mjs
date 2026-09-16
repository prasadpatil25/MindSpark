// The custom theme's --node-bg swatch is the card colour to the person editing
// it, but --node-bg is also the surface the dialogs, panels and inputs are
// painted with (see card-bg.test.mjs). A custom theme is applied inline on
// :root, so a translucent swatch there still made every dialog see-through.
// The swatch now goes to --card-bg, and --node-bg gets the same colour with
// its alpha stripped - for the applied theme, the live preview while a swatch
// is dragged, and the snapshot/restore around the Add-a-theme editor.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const CUSTOM_THEME_VARS = extractConst('CUSTOM_THEME_VARS');
const CUSTOM_THEME_INLINE = [...CUSTOM_THEME_VARS, '--card-bg'];

const fakeRoot = () => {
  const vars = new Map(); const attrs = new Map();
  return {
    vars, attrs,
    style: { setProperty: (k, v) => vars.set(k, v), removeProperty: k => vars.delete(k), getPropertyValue: k => vars.get(k) || '' },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), getAttribute: k => attrs.get(k) || null,
  };
};
const palette = (nodeBg) => Object.fromEntries(CUSTOM_THEME_VARS.map(k => [k, k === '--node-bg' ? nodeBg : '#123456']));

describe('opaqueColor strips an alpha channel and leaves everything else alone', () => {
  const { opaqueColor } = loadFns(['opaqueColor']);
  test('hex, functional and slash notations', () => {
    assert.equal(opaqueColor('#ffffff80'), '#ffffff');
    assert.equal(opaqueColor('#FFF8'), '#FFF');
    assert.equal(opaqueColor('rgba(255, 0, 0, .5)'), 'rgb(255, 0, 0)');
    assert.equal(opaqueColor('hsla(200,50%,50%,0.3)'), 'hsl(200, 50%, 50%)');
    assert.equal(opaqueColor('rgb(255 0 0 / 50%)'), 'rgb(255 0 0)');
  });
  test('already-opaque and non-literal colours pass through', () => {
    assert.equal(opaqueColor('#ffffff'), '#ffffff');
    assert.equal(opaqueColor('#fff'), '#fff');
    assert.equal(opaqueColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
    assert.equal(opaqueColor('color-mix(in srgb, red 50%, blue)'), 'color-mix(in srgb, red 50%, blue)');
    assert.equal(opaqueColor('white'), 'white');
    assert.equal(opaqueColor(''), '');
  });
});

describe('setPaletteVar routes the node swatch', () => {
  const { setPaletteVar } = loadFns(['setPaletteVar', 'opaqueColor']);
  test('--node-bg becomes --card-bg as entered plus an opaque --node-bg', () => {
    const root = fakeRoot();
    setPaletteVar(root, '--node-bg', '#ffffff80');
    assert.equal(root.vars.get('--card-bg'), '#ffffff80');
    assert.equal(root.vars.get('--node-bg'), '#ffffff');
  });
  test('every other variable is written as it is', () => {
    const root = fakeRoot();
    setPaletteVar(root, '--paper', '#f4f4f480');
    assert.equal(root.vars.get('--paper'), '#f4f4f480');
    assert.equal(root.vars.has('--card-bg'), false);
  });
});

describe('applying and previewing a custom theme', () => {
  function env(theme) {
    const root = fakeRoot();
    const store = {};
    const fns = loadFns(['applyCustomTheme', 'clearCustomThemeVars', 'previewCustomThemeVars', 'setPaletteVar', 'opaqueColor'], {
      CUSTOM_THEME_VARS, CUSTOM_THEME_INLINE,
      loadCustomTheme: () => theme,
      document: { documentElement: root },
      localStorage: { setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
      map: null, render: () => {},
    });
    return { root, store, ...fns };
  }

  test('applyCustomTheme: a glassy swatch reaches the cards, the dialogs stay opaque', () => {
    const e = env({ v: 1, id: 'glass', name: 'Glass', vars: palette('rgba(255,255,255,.5)') });
    e.applyCustomTheme();
    assert.equal(e.root.getAttribute('data-theme'), 'custom');
    assert.equal(e.root.vars.get('--card-bg'), 'rgba(255,255,255,.5)');
    assert.equal(e.root.vars.get('--node-bg'), 'rgb(255, 255, 255)');
    assert.equal(e.root.vars.get('--paper'), '#123456', 'the rest of the palette is applied as before');
    assert.equal(e.store['mindspark:theme'], 'custom');
  });

  test('previewCustomThemeVars: the live preview while dragging a swatch does the same', () => {
    const e = env(null);
    e.previewCustomThemeVars(JSON.stringify({ vars: { '--node-bg': '#ff000080', '--ink': '#000' } }));
    assert.equal(e.root.vars.get('--card-bg'), '#ff000080');
    assert.equal(e.root.vars.get('--node-bg'), '#ff0000');
    assert.equal(e.root.vars.get('--ink'), '#000');
  });

  test('clearCustomThemeVars removes --card-bg with the palette, so a built-in theme starts clean', () => {
    const e = env({ v: 1, id: 'glass', name: 'Glass', vars: palette('#ffffff80') });
    e.applyCustomTheme();
    e.clearCustomThemeVars();
    assert.equal(e.root.vars.size, 0);
  });

  test('a stale "custom" with no theme behind it clears --card-bg too', () => {
    const e = env(null);
    e.root.style.setProperty('--card-bg', '#ffffff80');
    e.applyCustomTheme();
    assert.equal(e.root.vars.has('--card-bg'), false);
    assert.equal(e.store['mindspark:theme'], 'light');
  });
});

describe('the Add-a-theme editor', () => {
  const form = extractFunction('showThemeImportForm');
  const lib = extractFunction('importLibraryTheme');

  test('snapshots and restores --card-bg along with the 20 palette variables', () => {
    assert.match(form, /for\(const key of CUSTOM_THEME_INLINE\) rootInline\[key\]/);
    assert.match(form, /for\(const key of CUSTOM_THEME_INLINE\)\{\r?\n\s*if\(rootInline\[key\]\)/);
    assert.doesNotMatch(form, /for\(const key of CUSTOM_THEME_VARS\) rootInline/);
  });

  test('the sample palette shows the node swatch as it was entered, not the stripped surface', () => {
    assert.match(form, /\(k==='--node-bg' && cur\) \? cur\.vars\[k\] : live\.getPropertyValue\(k\)\.trim\(\)/);
  });

  test('importing a library theme clears and restores the same set of inline variables', () => {
    assert.match(lib, /for\(const key of CUSTOM_THEME_INLINE\) saved\[key\]/);
    assert.match(lib, /for\(const key of CUSTOM_THEME_INLINE\) root\.style\.removeProperty\(key\);/);
    assert.match(lib, /for\(const key of CUSTOM_THEME_VARS\) vars\[key\]=cs\.getPropertyValue\(key\)\.trim\(\);/, 'the palette read still covers exactly the 20 theme variables');
  });

  test('CUSTOM_THEME_INLINE is the palette plus --card-bg, and the stored theme format is unchanged', () => {
    assert.match(APP, /const CUSTOM_THEME_INLINE = \[\.\.\.CUSTOM_THEME_VARS, '--card-bg'\];/);
    assert.equal(CUSTOM_THEME_VARS.includes('--card-bg'), false, 'themes/*.json keep their 20 keys; --card-bg is derived, never stored');
  });
});
