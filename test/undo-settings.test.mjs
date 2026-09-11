// The four settings dialogs (layout / map style / look / colour theme) write a
// per-map config and call pushHistory(), which reads as "Ctrl+Z takes this
// back". It did not: the snapshot did not include those fields, so the entry
// was identical to the previous one and dropped, and the next undo reverted
// whatever node edit came before. Both halves are pinned here against the
// real pushHistory() / restore() / undo() / redo(), driven with a fake map.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/load-app-fns.mjs';

function harness() {
  const calls = [];
  const map = { id: 'm', rootId: 'r', title: 'T', color: '#e0613a', layout: 'balanced',
    nodes: { r: { id: 'r', text: 'Root', parent: null } } };
  const titleEl = { value: '' };
  const api = new Function('$', 'autoLayout', 'updateUndo',
    `let map = arguments[3]; let history = [], hpos = -1;
     const scheduleSave = () => {}, mdMode = false, _mdSyncing = false, syncTextFromMap = () => {};
     ${extractFunction('historySnapshot')}
     ${extractFunction('pushHistory')}
     ${extractFunction('restore')}
     ${extractFunction('undo')}
     ${extractFunction('redo')}
     return { pushHistory, undo, redo, get map(){ return map; }, get depth(){ return history.length; }, get pos(){ return hpos; } };`)(
    () => titleEl, () => calls.push('autoLayout'), () => {}, map);
  return { api, map, calls };
}

describe('undo covers the settings dialogs', () => {
  test('applying a layout setting is its own history entry, and undo takes only it back', () => {
    const { api, map } = harness();
    api.pushHistory();                                   // baseline
    map.nodes.a = { id: 'a', text: 'A', parent: 'r' };   // a node edit
    api.pushHistory();
    map.layoutConfig = { balanced: { hGap: 120 } };      // what showLayoutConfigForm() writes
    api.pushHistory();
    assert.equal(api.depth, 3, 'the setting produced a new entry');
    api.undo();
    assert.equal(api.map.layoutConfig, undefined, 'the setting is gone');
    assert.ok(api.map.nodes.a, 'the node edit before it is untouched');
    api.undo();
    assert.ok(!api.map.nodes.a, 'a second undo reverts the node edit');
  });

  test('map style, look, theme, preset and title-auto round-trip through undo and redo', () => {
    const { api, map } = harness();
    api.pushHistory();
    Object.assign(map, { style: 'neon', layoutPreset: 'org-chart', styleConfig: { neon: { glow: 2 } },
      lookConfig: { lab: { radius: 3 } }, themeConfig: { dark: { paper: '#000' } } });
    api.pushHistory();
    api.undo();
    for (const k of ['style', 'layoutPreset', 'styleConfig', 'lookConfig', 'themeConfig']) {
      assert.equal(api.map[k], undefined, k + ' reverted');
    }
    api.redo();
    assert.equal(api.map.style, 'neon');
    assert.deepEqual(api.map.styleConfig, { neon: { glow: 2 } });
    assert.deepEqual(api.map.themeConfig, { dark: { paper: '#000' } });
  });

  test('a no-op push is still deduplicated', () => {
    const { api } = harness();
    api.pushHistory(); api.pushHistory(); api.pushHistory();
    assert.equal(api.depth, 1);
  });

  test('restore re-lays out and refreshes the title field', () => {
    const { api, map, calls } = harness();
    api.pushHistory();
    map.title = 'Changed'; api.pushHistory();
    api.undo();
    assert.equal(api.map.title, 'T');
    assert.deepEqual(calls, ['autoLayout']);
  });
});
