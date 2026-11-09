// Printing a map without its background. The live canvas cannot be printed
// (pan/zoom viewport clipped to the window, look texture painted around it),
// so Export offers a "Print map" action that prints a background-free PNG
// render through the browser's dialog.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction } from './helpers/load-app-fns.mjs';

const CSS = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('background-free export and print', () => {
  test('the Export menu offers Print map and wires it to exportPNG', () => {
    const src = extractFunction('exportMenu');
    assert.match(src, /data-a="print"/);
    assert.doesNotMatch(src, /data-a="pngbare"/, 'no separate no-background PNG item');
    assert.match(src, /a==='print'\) exportPNG\(\{ print:true \}\)/);
  });

  test('exportPNG skips the paper fill and the look texture when printing', () => {
    const src = extractFunction('exportPNG');
    assert.match(src, /const noBg=!!opts\.print;/);
    assert.match(src, /if\(!noBg\)\{ ctx\.fillStyle=stageBg; ctx\.fillRect\(0,0,W,H\); \}/);
    assert.match(src, /if\(!noBg\) drawLookBg\(\);/);
    assert.doesNotMatch(src, /^\s*drawLookBg\(\);/m, 'the texture must never be painted unconditionally');
  });

  test('the print path prints the render instead of downloading it', () => {
    assert.match(extractFunction('exportPNG'), /if\(opts\.print\)\{ printMapImage\(b, W>H\); return; \}/);
    const src = extractFunction('printMapImage');
    assert.match(src, /window\.print\(\)/);
    assert.match(src, /addEventListener\('afterprint', cleanup\)/);
    assert.match(src, /URL\.revokeObjectURL\(url\)/, 'the blob URL is released after printing');
    assert.match(src, /size:'\+\(landscape\?'landscape':'portrait'\)/);
  });

  test('while printing, only the map image is on a white page', () => {
    assert.match(CSS, /#mapPrintRoot\{display:none\}/);
    assert.match(CSS, /html\.map-printing body > \*:not\(#mapPrintRoot\)\{display:none !important\}/);
    assert.match(CSS, /html\.map-printing, html\.map-printing body, html\.map-printing #mapPrintRoot\{background:#fff !important\}/);
  });
});
