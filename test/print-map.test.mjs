// Printing a map. The live canvas cannot be printed (pan/zoom viewport clipped
// to the window, look texture painted around it), so Export -> Print map
// renders the map as a PNG with no background, in the light theme's colours
// whatever theme is active, and prints that through the browser's dialog.
// The markdown "Download PDF" shares the same print helper, printOnly().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const CSS = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const CUSTOM_THEME_VARS = extractConst('CUSTOM_THEME_VARS');
const CUSTOM_THEME_INLINE = [...CUSTOM_THEME_VARS, '--card-bg'];

// A minimal DOM: elements by id, a class list on <html>, a page title, and
// window.print / afterprint. Timers are collected and run by hand.
function printEnv({ title = 'Plan: Q3 / Q4?' } = {}) {
  const byId = new Map();
  const classes = new Set();
  const listeners = new Map();
  const timers = [];
  const el = tag => ({ tag, id: '', children: [], textContent: '',
    appendChild(c) { this.children.push(c); },
    set innerHTML(v) { this.html = v; } });
  const document = {
    title: 'MindSpark',
    body: { appendChild: c => byId.set(c.id, c) },
    head: { appendChild: c => byId.set(c.id, c) },
    documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
    getElementById: id => byId.get(id) || null,
    createElement: el,
  };
  const env = { prints: 0, toasts: [], revoked: [], classes, timers, document };
  const window = {
    print: () => { env.prints++; env.atPrint = { title: document.title, classes: [...classes] }; },
    addEventListener: (t, f) => listeners.set(t, f),
    removeEventListener: (t, f) => { if (listeners.get(t) === f) listeners.delete(t); },
  };
  env.window = window;
  env.afterprint = () => listeners.get('afterprint') && listeners.get('afterprint')();
  env.runTimers = () => { while (timers.length) timers.shift()(); };
  env.root = id => byId.get(id);
  env.deps = {
    document, window, map: { title },
    setTimeout: f => timers.push(f),
    toast: m => env.toasts.push(m),
    URL: { createObjectURL: () => 'blob:map', revokeObjectURL: u => env.revoked.push(u) },
  };
  return env;
}
const tick = () => new Promise(r => setImmediate(r));

describe('printOnly - the shared print helper', () => {
  const load = env => loadFns(['printOnly'], env.deps).printOnly;

  test('fills the container, then prints with the class set and a clean filename', async () => {
    const env = printEnv();
    await load(env)('mdPrintRoot', 'md-printing', root => { root.html = '<h1>Plan</h1>'; });
    assert.equal(env.root('mdPrintRoot').html, '<h1>Plan</h1>');
    assert.equal(env.prints, 0, 'print waits for the layout to settle');
    env.timers.shift()();
    assert.deepEqual(env.atPrint, { title: 'Plan Q3  Q4', classes: ['md-printing'] });
  });

  test('afterprint puts everything back and runs the undo once', async () => {
    const env = printEnv();
    let undone = 0;
    await load(env)('mapPrintRoot', 'map-printing', () => () => undone++);
    env.timers.shift()();
    env.afterprint();
    env.runTimers();   // the 1s fallback must not undo twice
    assert.equal(env.document.title, 'MindSpark');
    assert.equal(env.classes.size, 0);
    assert.equal(env.root('mapPrintRoot').textContent, '');
    assert.equal(undone, 1);
  });

  test('without afterprint, the fallback timer still cleans up', async () => {
    const env = printEnv();
    await load(env)('mapPrintRoot', 'map-printing', () => {});
    env.runTimers();
    assert.equal(env.prints, 1);
    assert.equal(env.classes.size, 0);
    assert.equal(env.document.title, 'MindSpark');
  });

  test('waits for asynchronous content, and prints nothing if it fails', async () => {
    const env = printEnv();
    let resolve;
    const done = load(env)('mapPrintRoot', 'map-printing', () => new Promise(r => { resolve = r; }));
    await tick();
    assert.equal(env.classes.size, 0, 'not in print mode until the content is ready');
    resolve();
    await done;
    assert.ok(env.classes.has('map-printing'));

    const env2 = printEnv();
    await assert.rejects(load(env2)('mapPrintRoot', 'map-printing', async () => { throw new Error('no'); }));
    env2.runTimers();
    assert.equal(env2.prints, 0);
    assert.equal(env2.document.title, 'MindSpark');
  });

  test('an untitled map gets a sensible filename', async () => {
    const env = printEnv({ title: '' });
    await load(env)('mdPrintRoot', 'md-printing', () => {});
    env.timers.shift()();
    assert.equal(env.atPrint.title, 'mindmap');
  });
});

describe('both print actions go through printOnly', () => {
  function withImage(env, outcome) {
    env.deps.Image = class { set src(v) { this._src = v; setImmediate(() => this[outcome]()); } };
    return loadFns(['printMapImage', 'printOnly'], env.deps).printMapImage;
  }

  test('Print map prints the image on a page that matches its shape', async () => {
    const env = printEnv();
    withImage(env, 'onload')({}, true);
    await tick(); await tick();
    assert.equal(env.root('mapPrintRoot').children[0]._src, 'blob:map');
    assert.match(env.root('mapPrintPage').textContent, /size:landscape/);
    env.timers.shift()();
    assert.equal(env.prints, 1);
    assert.deepEqual(env.atPrint.classes, ['map-printing']);
    env.afterprint();
    assert.equal(env.root('mapPrintPage').textContent, '', 'the @page rule does not outlive the print');
    assert.deepEqual(env.revoked, ['blob:map']);
  });

  test('if the image fails, the user is told and nothing prints or leaks', async () => {
    const env = printEnv();
    withImage(env, 'onerror')({}, false);
    await tick(); await tick(); await tick();
    env.runTimers();
    assert.equal(env.prints, 0);
    assert.deepEqual(env.toasts, ['Could not prepare the map for printing']);
    assert.deepEqual(env.revoked, ['blob:map']);
  });

  test('Download PDF prints the markdown the same way', async () => {
    const env = printEnv();
    const { mdDownloadPdf } = loadFns(['mdDownloadPdf', 'printOnly'], {
      ...env.deps, mdToHtml: t => `<p>${t}</p>`, _mdFullText: 'hello' });
    mdDownloadPdf();
    await tick();
    assert.equal(env.root('mdPrintRoot').html, '<p>hello</p>');
    env.timers.shift()();
    assert.deepEqual(env.atPrint.classes, ['md-printing']);
  });
});

describe('print colours are the light theme, whatever is on screen', () => {
  const LIGHT = { '--ink': '#23201b', '--card-bg': '#ffffff', '--line-2': '#c8bda8', '--link': '#b8451f', '--sticky-ink': '#4a431f' };
  const DARK = { '--ink': '#d4d4d4', '--card-bg': '#2d2d2d', '--line-2': '#555555', '--link': '#3794ff', '--sticky-ink': '#f3ecc4' };
  function reader(print) {
    const inline = new Map([['--card-bg', '#00000080'], ['--sans', 'Comic Sans']]);   // per-map card colour + look font
    const attrs = new Map([['data-theme', 'dark']]);
    const root = {
      style: { getPropertyValue: k => inline.get(k) || '', setProperty: (k, v) => inline.set(k, v), removeProperty: k => inline.delete(k) },
      getAttribute: k => attrs.get(k) || null, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    };
    // Live, like the real CSSStyleDeclaration: re-reads the cascade each call.
    const getComputedStyle = el => ({ getPropertyValue: k =>
      el.style.getPropertyValue(k) || (el.getAttribute('data-theme') === 'dark' ? DARK : LIGHT)[k] || '' });
    const { exportCssReader } = loadFns(['exportCssReader', 'themePalette'], {
      CUSTOM_THEME_INLINE, document: { documentElement: root }, getComputedStyle });
    return { css: exportCssReader(print), attrs, inline };
  }

  test('printing on a dark theme draws with dark ink, white cards and light lines', () => {
    const { css } = reader(true);
    for (const k of Object.keys(LIGHT)) assert.equal(css(k), LIGHT[k], k);
  });

  test('fonts and sizes still follow the live look', () => {
    assert.equal(reader(true).css('--sans'), 'Comic Sans');
  });

  test('the colours are fixed when the export starts, not when they are read', () => {
    const { css, attrs } = reader(true);
    attrs.delete('data-theme');
    attrs.set('data-theme', 'dark');
    assert.equal(css('--ink'), LIGHT['--ink']);
  });

  test('the PNG download keeps the live theme', () => {
    const { css } = reader(false);
    assert.equal(css('--ink'), DARK['--ink']);
    assert.equal(css('--card-bg'), '#00000080');
  });

  test('link colours come from the export palette, not the live theme', () => {
    assert.match(extractFunction('exportPNG'), /linkColor:\s*css\('--link'\)/);
    assert.match(extractFunction('drawFormattedText'), /opts\.linkColor\s*\|\|/);
  });
});

describe('wiring', () => {
  // exportPNG draws on a real canvas, so these two stay source checks.
  test('the Export menu offers Print map, and no separate no-background PNG', () => {
    const src = extractFunction('exportMenu');
    assert.match(src, /data-a="print"/);
    assert.match(src, /exportPNG\(\s*\{\s*print:\s*true\s*\}\s*\)/);
    assert.doesNotMatch(src, /data-a="pngbare"/);
  });

  test('printing skips the paper fill and the look texture, and uses the print palette', () => {
    const src = extractFunction('exportPNG');
    assert.match(src, /exportCssReader\(\s*noBg\s*\)/);
    assert.match(src, /if\s*\(\s*!noBg\s*\)\s*\{\s*ctx\.fillStyle\s*=\s*stageBg/);
    assert.match(src, /if\s*\(\s*!noBg\s*\)\s*drawLookBg\(\)/);
    assert.doesNotMatch(src, /^\s*drawLookBg\(\);/m, 'the texture must never be painted unconditionally');
  });

  test('while printing, only the print container is on a white page', () => {
    assert.match(CSS, /#mapPrintRoot\{display:none\}/);
    assert.match(CSS, /html\.map-printing body > \*:not\(#mapPrintRoot\)\{display:none !important\}/);
    assert.match(CSS, /html\.md-printing body > \*:not\(#mdPrintRoot\)\{display:none !important\}/);
  });
});
