// Ways an edit used to disappear, each pinned here:
//  - previewing an old version, then touching it (a drag, a collapse), autosaved
//    the OLD version over the map - the banner said "read-only", nothing was;
//  - restoring a version dropped the map's pin, share binding and per-map settings;
//  - creating a map from a template cancelled the outgoing map's pending save;
//  - closing or reloading within the save debounce lost the last edit silently;
//  - type-to-replace wrote the key into the model before editing began, so Escape
//    could not bring the old text back and the next autosave stored the key -
//    and '?' (the documented shortcuts help) replaced the selected node's text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => extractFunction(name);
let n = 0;
const { normalizeLoadedMap } = loadFns(['normalizeLoadedMap', 'sanitizeMapData', 'sanitizeNodeFields', 'repairTree', 'safeColor', 'safeImageUrl'], {
  uid: () => 'u' + (++n), SAFE_COLOR_RE: extractConst('SAFE_COLOR_RE'), SAFE_ID_RE: extractConst('SAFE_ID_RE'),
  SAFE_IMAGE_RE: extractConst('SAFE_IMAGE_RE'), NODE_ALIGNS: extractConst('NODE_ALIGNS'), UNSAFE_NODE_IDS: extractConst('UNSAFE_NODE_IDS'),
});

describe('version history', () => {
  test('a loaded version keeps its per-map settings', () => {
    const v = normalizeLoadedMap({ id: 'm', title: 'T', rootId: 'r', nodes: { r: { text: 'R', parent: null } },
      layoutPreset: 'tl', layoutParams: { colGap: 64, rowGap: 16 }, layoutConfig: { balanced: { hGap: 90 } }, styleConfig: { modern: { dash: 3 } },
      lookConfig: { office: { nodeSize: 1.2 } }, themeConfig: { light: { paper: '#fff' } }, frontmatter: '---\na: 1\n---' });
    for (const k of ['layoutPreset', 'layoutParams', 'layoutConfig', 'styleConfig', 'lookConfig', 'themeConfig', 'frontmatter']) assert.ok(v[k], k);
  });

  test('previewing makes the map read-only and marks the preview object', () => {
    const body = fn('previewVersion');
    assert.match(body, /_historyPreview\.preview = map/);
    assert.match(body, /READONLY = true/);
    const end = fn('endHistoryPreview');
    assert.match(end, /READONLY=hp\.readonly/);
    assert.match(end, /if\(restore && map===hp\.preview\)/);
  });

  test('scheduleSave refuses the preview object', () => {
    const timers = [];
    const preview = { id: 'm' };
    const run = new Function('$', 'setTimeout', 'clearTimeout', 'MODE', 'READONLY',
      `let map = arguments[5]; let saveTimer = null; let _pendingSaveMap = null; let scheduleCloudSave = () => {};
       let _historyPreview = { preview: map };
       ${fn('scheduleSave')}
       return scheduleSave;`)(() => ({ classList: { add() {} }, textContent: '' }), (f) => timers.push(f), () => {}, 'server', false, preview);
    run();
    assert.equal(timers.length, 0, 'nothing is scheduled for the preview');
  });

  test('restore keeps the pin and the share binding of the current map', () => {
    const body = fn('restoreVersion');
    assert.match(body, /\['pinned','_shareRoom','_editToken'\]/);
    assert.match(body, /endHistoryPreview\(false\)/);
    assert.doesNotMatch(body, /await Store\.save\(map\)/, 'saves go through the one runner');
  });

  test('every map switch ends a preview', () => {
    for (const name of ['loadMap', 'createMap', 'createMapFromTemplate', '_activateTab', 'openSharedInPlace']) {
      assert.match(fn(name), /endHistoryPreview\(false\)/, name);
    }
  });
});

describe('switching maps and leaving the page', () => {
  test('a map from a template flushes the outgoing map first', () => {
    const body = fn('createMapFromTemplate');
    const flush = body.indexOf('flushPendingSave()'), swap = body.indexOf('map = {');
    assert.ok(flush > 0 && swap > flush, 'flush before the new map replaces the old one');
    assert.match(body, /exitSharedMode\(\)/);
  });

  test('unsaved work holds the page and is flushed on the way out', () => {
    assert.match(SRC, /window\.addEventListener\('beforeunload', e=>\{\s*if\(!hasUnsavedWork\(\)\) return;/);
    assert.match(SRC, /window\.addEventListener\('pagehide', \(\)=>\{ flushPendingSave\(\);/);
    const h = fn('hasUnsavedWork');
    assert.match(h, /saveTimer/); assert.match(h, /_savesInFlight/); assert.match(h, /_cloudSaveTimer/);
  });

  test('small server saves are keepalive so they finish as the page closes', () => {
    const store = SRC.slice(SRC.indexOf('const ServerStore = {'), SRC.indexOf('/* ------------------------------------------------------------\n   Forge registry'));
    assert.match(store, /keepalive\}/);
  });
});

describe('type-to-replace and the ? shortcut', () => {
  const keys = SRC.slice(SRC.indexOf("window.addEventListener('keydown',e=>{\n  // ime-exempt: bails on every text field"), SRC.indexOf("stage.addEventListener('dblclick'"));
  test('the typed key seeds the editor, never the model', () => {
    assert.doesNotMatch(keys, /map\.nodes\[sel\]\.text=e\.key/);
    assert.match(keys, /startEdit\(sel, e\.key\)/);
    assert.match(fn('startEdit'), /const raw = seed!=null \? String\(seed\)/);
  });
  test("'?' is left to the shortcuts help", () => {
    const q = keys.indexOf("e.key==='?'"), rep = keys.indexOf('e.key.length===1');
    assert.ok(q > 0 && q < rep, "the '?' branch comes before replace mode");
  });
  test('leaving an edit rebuilds the node from the model', () => {
    assert.match(fn('startEdit'), /_nodeSig\.delete\(id\);\s*autoLayout\(\);/);
    assert.match(fn('startBlockEdit'), /_nodeSig\.delete\(id\)/);
  });
});
