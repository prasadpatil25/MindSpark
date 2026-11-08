// Bugs you could see in the running app, each reproduced before it was fixed:
//  - the Tidy button did nothing (its click event arrived as autoLayout's noRender);
//  - a read-only view (shared link, version preview) took Delete, typing, L,
//    shift-click bulk edits, touch drags, node resizing and task toggles;
//  - render() re-appended every node on every pass, which also took focus away
//    from the node being edited whenever a collaborator's change arrived;
//  - a transparent PNG attachment turned black (re-encoded as JPEG);
//  - a big map's PNG export failed silently past the browser's canvas limits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => extractFunction(name);

test('the Tidy button calls autoLayout with no arguments', () => {
  assert.match(SRC, /\$\('#layout'\)\.onclick=\(\)=>autoLayout\(\);/);
  assert.doesNotMatch(SRC, /\$\('#layout'\)\.onclick=autoLayout;/);
});

describe('read-only views accept navigation, never edits', () => {
  test('the keyboard lets only arrows, Space and Escape through', () => {
    assert.match(SRC, /if\(READONLY && !\['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Escape'\]\.includes\(e\.key\)\) return;/);
  });
  for (const [name, re] of [
    ['deleteNode', /if\(READONLY \|\| id===map\.rootId\) return;/],
    ['startLinkMode', /if\(!sourceId \|\| READONLY\)/],
    ['completeLink', /if\(READONLY\) return;/],
    ['cycleTask', /if\(!n \|\| READONLY\) return;/],
    ['startResize', /if\(READONLY\) return;/],
  ]) test(name + ' refuses', () => assert.match(fn(name), re));
  test('shift-click does not open the bulk bar, and a touch cannot drag', () => {
    assert.match(SRC, /if\(e\.shiftKey\)\{\s*if\(!READONLY\) toggleMultiSelect\(id\);/);
    assert.match(SRC, /if\(READONLY\)\{ dragNode=null; return; \}/);
  });
  test('notes and references open view-only', () => {
    assert.match(fn('showNotesEditor'), /editor\.contentEditable='false'/);
    assert.match(fn('showCitationForm'), /ta\.readOnly=true/);
  });
});

describe('render() moves elements only when it has to', () => {
  const body = fn('render');
  test('an unchanged element stays put while the order still matches', () => {
    assert.match(body, /if\(!_inOrder && !_old\.classList\.contains\('editing'\)\) viewport\.appendChild\(_old\);/);
  });
  test('a rebuilt element goes back at its own index, not the end', () => {
    // Appending a rebuilt element to the end forced every later element to be
    // re-appended too: about 1500 DOM moves for one changed node on a big map.
    assert.match(body, /if\(_sameOrder\)\{[\s\S]*?_nodeEls\.get\(_order\[j\]\)[\s\S]*?viewport\.insertBefore\(el,_next\)/);
  });
  test('the order check covers hidden nodes, so collapse/expand is not a reorder', () => {
    assert.match(body, /_allOrder\.push\(id\)/);
    assert.match(body, /_lastNodeOrder=_allOrder;/);
  });
});

describe('image attachments keep transparency', () => {
  const { imageHasAlpha } = loadFns(['imageHasAlpha']);
  const ctx = alphas => ({ getImageData: () => ({ data: Uint8ClampedArray.from(alphas.flatMap(a => [10, 20, 30, a])) }) });
  test('any non-opaque pixel means PNG', () => {
    assert.equal(imageHasAlpha(ctx([255, 255, 0]), 3, 1), true);
    assert.equal(imageHasAlpha(ctx([255, 128]), 2, 1), true);
  });
  test('a fully opaque image stays JPEG', () => assert.equal(imageHasAlpha(ctx([255, 255, 255]), 3, 1), false));
  test('the encoder is chosen by it, and the map is re-checked after the async load', () => {
    const body = fn('readImageFile');
    assert.match(body, /data=encodeImageAttachment\(cv,cx,w,h\)/);
    assert.match(body, /if\(map!==target \|\| !map\.nodes\[id\]\)/);
  });
});

// Issue #61: attachments were cut to 360px wide and JPEG'd, so a diagram shown
// at 2x DPR or zoomed in was enlarged ~3x and its text was unreadable.
describe('image attachments stay sharp', () => {
  const alphaCtx = a => ({ getImageData: () => ({ data: Uint8ClampedArray.from([1, 2, 3, a]) }) });
  const canvas = (pngLen, jpgLen) => ({ toDataURL: t => (t === 'image/png' ? 'P' : 'J').repeat(t === 'image/png' ? pngLen : jpgLen) });
  const { imageAttachSize, encodeImageAttachment } = loadFns(['imageHasAlpha', 'imageAttachSize', 'encodeImageAttachment']);
  test('a wide screenshot keeps 3x the 400px display cap', () => assert.deepEqual(imageAttachSize(2132, 1328), { w: 1200, h: 747 }));
  test('a small image is never enlarged', () => assert.deepEqual(imageAttachSize(300, 200), { w: 300, h: 200 }));
  test('a very tall image is capped by height', () => assert.deepEqual(imageAttachSize(1000, 5000), { w: 480, h: 2400 }));
  test('a sliver never collapses to zero', () => assert.equal(imageAttachSize(100000, 10).h, 1));
  test('opaque flat colour keeps PNG when it is smaller', () => assert.match(encodeImageAttachment(canvas(10, 20), alphaCtx(255), 1, 1), /^P+$/));
  test('an opaque photo uses JPEG when it is smaller', () => assert.match(encodeImageAttachment(canvas(20, 10), alphaCtx(255), 1, 1), /^J+$/));
  test('transparency always means PNG', () => assert.match(encodeImageAttachment(canvas(20, 10), alphaCtx(0), 1, 1), /^P+$/));
  test('the resample uses high-quality smoothing', () => assert.match(fn('readImageFile'), /cx\.imageSmoothingQuality='high';\s*cx\.drawImage/));
});

describe('PNG export stays inside the canvas limits', () => {
  const { pngExportScale } = loadFns(['pngExportScale']);
  test('an ordinary map exports at 2x', () => assert.equal(pngExportScale(2000, 1200, false), 2));
  test('a wide map is scaled to the 16384px edge', () => assert.ok(pngExportScale(20000, 1000, false) * 20000 <= 16384 + 1e-6));
  test('iOS gets its 16.7M pixel area', () => {
    const k = pngExportScale(5000, 4000, true);
    assert.ok(5000 * k * 4000 * k <= 16777216 + 1);
  });
  test('an empty blob is reported, not downloaded', () => {
    assert.match(fn('exportPNG'), /if\(!b\)\{ toast\(/);
  });
});
