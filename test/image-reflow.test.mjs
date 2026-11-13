// An attached image has no intrinsic size until it loads, and a failed image
// falls back to alt text and drops the wider .has-image card. Either way the
// node changes size after render() measured it, so without a re-measure the
// next sibling stays at a position computed for the old size and overlaps it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

test('image load and error handlers re-measure before the next layout', () => {
  const body = extractFunction('render');
  assert.match(body, /img\.addEventListener\('error',[\s\S]*?remeasureNodeAndReflow\(id\);[\s\S]*?updateMinimap\(\);\s*\}\);/);
  assert.match(body, /img\.addEventListener\('load',\(\)=>\{\s*remeasureNodeAndReflow\(id\);\s*updateMinimap\(\);\s*\}\);/);
});

describe('remeasureNodeAndReflow', () => {
  function harness(rect, node = { x: 0, y: 0, w: 240, h: 100 }, strategy = 'tree') {
    const calls = { layout: 0, painted: 0, noRender: null };
    const el = {
      classList: { contains: () => strategy === 'treetable', remove() {}, add() {} },
      style: { removeProperty() {} },
      getBoundingClientRect: () => rect,
    };
    const map = { id: 'm1', layout: 'balanced', rootId: 'r1', nodes: { n1: node } };
    const fns = loadFns(['remeasureNodeAndReflow'], {
      map,
      view: { k: 2 },
      _uiZ: () => 1.5,
      document: { querySelector: () => el },
      layoutRunForMap: () => ({ strategy }),
      rememberNaturalSize: () => {},
      autoLayout: noRender => { calls.layout++; calls.noRender = noRender; },
      applyTreeTableCells: () => {},
      _treeTableCellSizes: null,
      paintPositions: () => { calls.painted++; },
    });
    return { ...fns, calls, node: map.nodes.n1 };
  }

  test('a stale size is replaced and the layout repainted without a DOM rebuild', () => {
    const h = harness({ width: 960, height: 300 });   // / (2 * 1.5) => 320 x 100
    h.remeasureNodeAndReflow('n1');
    assert.equal(h.node.w, 320);
    assert.equal(h.node.h, 100);
    assert.equal(h.calls.layout, 1);
    assert.equal(h.calls.noRender, true);
    assert.equal(h.calls.painted, 1);
  });

  test('a size that already matches skips the layout pass', () => {
    const h = harness({ width: 720, height: 300 });   // / (2 * 1.5) => 240 x 100
    h.remeasureNodeAndReflow('n1');
    assert.equal(h.calls.layout, 0);
    assert.equal(h.calls.painted, 0);
  });
});
