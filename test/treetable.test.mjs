// Tree table strategy (issue #63).
//
// Three properties make this a table rather than a tree: depth fixes a
// column, a node's block spans its whole subtree, and siblings stack vertically
// inside that block. These tests pin those, plus the collapsed and empty cases.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const fns = loadFns(
  ['validateLayoutConfig', 'validateLayoutParams', 'validateLayoutPreset',
   'resolveLayout', 'layoutRunForMap', 'layoutTreeTable', 'rememberNaturalSize',
   '_shareePayload', 'cloudDiff'],
  {
    LAYOUT_PARAMS: extractConst('LAYOUT_PARAMS'),
    ENGINE_PARAMS: extractConst('ENGINE_PARAMS'),
    LAYOUT_ENGINES: extractConst('LAYOUT_ENGINES'),
    LAYOUT_CONFIG_DEFAULTS: extractConst('LAYOUT_CONFIG_DEFAULTS'),
    LAYOUT_CONFIG_BOUNDS: extractConst('LAYOUT_CONFIG_BOUNDS'),
  }
);
const layoutTreeTable = fns.layoutTreeTable;

const OPTS = { colGap:40, rowGap:10 };
const build = (tree, sizes = {}) => {
  const nodes = {};
  for (const id of Object.keys(tree)) {
    const s = sizes[id] || {};
    nodes[id] = { id, w:s.w || 120, h:s.h || 40, x:0, y:0 };
  }
  return { nodes, kidsOf:id => tree[id] || [] };
};
const round = v => Math.round(v);

// root -> a -> a1,a2
//      -> b -> b1
const TREE = {
  root:['a','b'],
  a:['a1','a2'], b:['b1'],
  a1:[], a2:[], b1:[],
};

describe('layoutTreeTable - depth becomes a column', () => {
  test('every node at one depth shares a left edge', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(round(nodes.a.x), round(nodes.b.x));
    assert.equal(round(nodes.a1.x), round(nodes.a2.x));
    assert.equal(round(nodes.a2.x), round(nodes.b1.x));
  });

  test('each depth sits to the right of the one before it', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.root.x < nodes.a.x);
    assert.ok(nodes.a.x < nodes.a1.x);
  });

  test('the widest card at a depth sets that column, not each node', () => {
    const { nodes, kidsOf } = build(TREE, { root:{ w:140 }, a1:{ w:200 } });
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    // Column 1 is still 120px wide, so b's right edge to b1 is the plain gap.
    assert.equal(round(nodes.b1.x - (nodes.b.x + nodes.b.w)), OPTS.colGap);
    // Column 2 is 200px wide because of a1, and b1 lines up with it.
    assert.equal(round(nodes.a1.x), round(nodes.b1.x));
  });

  test('the root owns the first column', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(round(nodes.root.x), 0);
    assert.equal(round(nodes.a.x - (nodes.root.x + nodes.root.w)), OPTS.colGap);
  });
});

describe('layoutTreeTable - blocks span their subtree', () => {
  test('leaf siblings stack with exactly the row gap', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(round(nodes.a2.y - (nodes.a1.y + nodes.a1.h)), OPTS.rowGap);
  });

  test('the next root child starts below the previous whole block', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    // a's subtree ends at a2's bottom (0 + 40 + 10 + 40 = 90).
    assert.equal(round(nodes.b.y), round(nodes.a1.h + OPTS.rowGap + nodes.a2.h + OPTS.rowGap));
  });

  test('a parent cell starts at the top of its children', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(round(nodes.a.y), round(nodes.a1.y));
  });

  test('a parent cell is as tall as the subtree it spans', () => {
    const { nodes, kidsOf } = build(TREE);
    const cells = layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    const first = nodes.a1, last = nodes.a2;
    assert.equal(round(cells.get('a').h), round(last.y + last.h - first.y));
  });

  test('the root cell spans the whole table', () => {
    const { nodes, kidsOf } = build(TREE);
    const cells = layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    const tableBottom = Math.max(...Object.values(nodes).map(n => n.y + n.h));
    assert.equal(round(cells.get('root').h), round(tableBottom));
    assert.equal(round(nodes.root.y), 0);
  });

  test('a parent taller than its subtree still centres the children', () => {
    const { nodes, kidsOf } = build(TREE, { a:{ h:160 } });
    const cells = layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    const childTop = nodes.a1.y;
    const childBottom = nodes.a2.y + nodes.a2.h;
    assert.equal(round(cells.get('a').h), 160);
    assert.equal(round((childTop + childBottom) / 2), 80);
    assert.ok(nodes.a1.y > nodes.a.y, 'the children are inset inside the tall block');
  });

  test('a collapsed node reserves only its own row', () => {
    const { nodes, kidsOf } = build(TREE);
    nodes.a.collapsed = true;
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    // a becomes a 40px leaf, so b follows one row gap later instead of after
    // a's hidden children.
    assert.equal(round(nodes.b.y), nodes.a.h + OPTS.rowGap);
    assert.equal(nodes.a1.x, 0, 'the hidden child is not placed');
  });
});

describe('layoutTreeTable - every shape stays placeable', () => {
  test('a single-node map', () => {
    const { nodes, kidsOf } = build({ root:[] });
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(nodes.root.x, 0);
    assert.equal(nodes.root.y, 0);
  });

  test('an empty map still gives the root a usable position', () => {
    const nodes = {};
    layoutTreeTable(nodes, 'missing', () => [], OPTS);
    assert.deepEqual(nodes, {});
  });

  test('all visible nodes are finite for several shapes', () => {
    const shapes = [
      TREE,
      { root:['a'], a:['a1'], a1:['a1a'], a1a:[] },
      { root:['a','b','c'], a:[], b:[], c:[] },
    ];
    for (const tree of shapes) {
      const { nodes, kidsOf } = build(tree);
      layoutTreeTable(nodes, 'root', kidsOf, OPTS);
      for (const [id, n] of Object.entries(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), id);
      }
    }
  });

  test('the root keeps the root side and children attach to the right', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutTreeTable(nodes, 'root', kidsOf, OPTS);
    assert.equal(nodes.root.side, 'root');
    assert.equal(nodes.a.side, 'right');
    assert.equal(nodes.a1.side, 'right');
  });
});

describe('layoutTreeTable - the natural-size cache stays out of the content', () => {
  test('rememberNaturalSize is readable but not serialized', () => {
    const n = { text: 'hello' };
    fns.rememberNaturalSize(n, 120, 40);
    assert.equal(n._nw, 120);
    assert.equal(n._nh, 40);
    assert.deepEqual(Object.keys(n), ['text']);
    assert.equal(JSON.stringify(n), '{"text":"hello"}');
  });

  test('a later measurement updates the hidden fields in place', () => {
    const n = {};
    fns.rememberNaturalSize(n, 120, 40);
    fns.rememberNaturalSize(n, 180, 60);
    assert.equal(n._nw, 180);
    assert.equal(n._nh, 60);
    assert.equal(JSON.stringify(n), '{}');
  });
});

describe('layoutRunForMap - a preset keeps its own spacing', () => {
  const { layoutRunForMap } = fns;

  test('the built-in tree table still gets its config defaults', () => {
    const run = layoutRunForMap('treetable', null, null);
    assert.equal(run.strategy, 'treetable');
    assert.equal(run.params.colGap, 16);
    assert.equal(run.params.rowGap, 6);
  });

  test('an imported preset\'s params are not replaced by the built-in defaults', () => {
    // The config validator returns defaults for every engine, so applying them
    // unconditionally is what made "Tree table (roomy)" render at 16/6.
    const run = layoutRunForMap('treetable', { colGap: 64, rowGap: 16 }, null);
    assert.equal(run.params.colGap, 64);
    assert.equal(run.params.rowGap, 16);
  });

  test('a config section saved on the map wins over a preset', () => {
    const run = layoutRunForMap(
      'treetable', { colGap: 64, rowGap: 16 },
      { treetable: { colGap: 24 } }
    );
    assert.equal(run.params.colGap, 24);
    assert.equal(run.params.rowGap, 6, 'unset keys fall back to the config defaults');
  });

  test('presets for other strategies keep their params too', () => {
    const radial = layoutRunForMap('radial', { ring: 300 }, null);
    assert.equal(radial.params.ring, 300);
    const grid = layoutRunForMap('grid', { columns: 2 }, null);
    assert.equal(grid.params.columns, 2);
  });

  test('a built-in engine still uses its config defaults', () => {
    const run = layoutRunForMap('down', null, null);
    assert.equal(run.strategy, 'tree');
    assert.equal(run.params.gapCross, 38);
    assert.equal(run.params.gapMain, 70);
  });
});

describe('tree table in a share link', () => {
  test('the preset spacing travels with the shared map', () => {
    // Without this the recipient saw the built-in 16/6 table and the layout
    // looked broken next to the sender's.
    const p = fns._shareePayload({
      title: 'T', rootId: 'r', nodes: {}, layout: 'treetable',
      layoutParams: { colGap: 64, rowGap: 16 },
    });
    assert.equal(p.layout, 'treetable');
    assert.deepEqual(p.layoutParams, { colGap: 64, rowGap: 16 });
  });

  test('a map without params does not gain an empty section', () => {
    const p = fns._shareePayload({ title: 'T', rootId: 'r', nodes: {}, layout: 'treetable' });
    assert.equal(p.layoutParams, undefined);
  });
});

describe('an editable shared map keeps its table settings', () => {
  test('a changed preset spacing becomes a meta op', () => {
    const ops = fns.cloudDiff(
      { layout: 'treetable' },
      { layout: 'treetable', layoutParams: { colGap: 64, rowGap: 16 } }
    );
    assert.deepEqual(ops, [{ t: 'meta', k: 'layoutParams', v: { colGap: 64, rowGap: 16 } }]);
  });

  test('unchanged spacing produces no op', () => {
    const same = { layout: 'treetable', layoutParams: { colGap: 64, rowGap: 16 } };
    assert.deepEqual(fns.cloudDiff(same, { ...same }), []);
  });

  test('the shared-map opener reads the params back', () => {
    // _shareePayload sends them, so dropping them here would make the owner
    // and every collaborator see different column gaps.
    assert.match(extractFunction('_applySharedMap'), /layoutParams:data\.layoutParams/);
  });
});

describe('layoutTreeTable - rootSide moves the root band', () => {
  const layoutFor = side => {
    const { nodes, kidsOf } = build(TREE);
    const cells = layoutTreeTable(nodes, 'root', kidsOf, { ...OPTS, rootSide: side });
    return { nodes, cells };
  };
  const rightEdge = cells => Math.max(...[...cells.values()].map(c => c.x + c.w));
  const bottomEdge = cells => Math.max(...[...cells.values()].map(c => c.y + c.h));

  test('left is the default and grows depth to the right', () => {
    const fallback = layoutFor(undefined);
    const left = layoutFor('left');
    assert.deepEqual(fallback.nodes, left.nodes);
    assert.ok(left.nodes.root.x < left.nodes.a.x);
  });

  test('right mirrors x, keeping rows and subtree heights unchanged', () => {
    const { nodes, cells } = layoutFor('right');
    const left = layoutFor('left');
    assert.ok(nodes.root.x > nodes.a.x);
    assert.ok(nodes.a.x > nodes.a1.x);
    assert.equal(round(nodes.root.x + cells.get('root').w), round(rightEdge(cells)));
    assert.ok(nodes.a.y < nodes.b.y, 'sibling order still reads top to bottom');
    assert.ok(nodes.a1.y < nodes.a2.y);
    for (const id of Object.keys(TREE)) {
      assert.equal(round(nodes[id].y), round(left.nodes[id].y), id);
      assert.equal(round(cells.get(id).h), round(left.cells.get(id).h), id);
    }
    assert.equal(nodes.root.side, 'root');
    assert.equal(nodes.a.side, 'left');
  });

  test('top turns depth into rows and keeps the root spanning the width', () => {
    const { nodes, cells } = layoutFor('top');
    assert.equal(round(nodes.root.y), 0);
    assert.ok(nodes.root.y < nodes.a.y);
    assert.ok(nodes.a.y < nodes.a1.y);
    assert.equal(round(nodes.a.y), round(nodes.b.y), 'one depth level shares a row');
    assert.equal(round(nodes.a2.y), round(nodes.b1.y));
    assert.ok(nodes.a.x < nodes.b.x, 'siblings read left to right');
    assert.ok(nodes.a1.x < nodes.a2.x);
    assert.equal(round(cells.get('root').w), round(rightEdge(cells)));
    assert.equal(nodes.a.side, 'down');
  });

  test('bottom mirrors top, so depth grows up towards the root', () => {
    const { nodes, cells } = layoutFor('bottom');
    assert.ok(nodes.root.y > nodes.a.y);
    assert.ok(nodes.a.y > nodes.a1.y);
    assert.equal(round(cells.get('root').y + cells.get('root').h), round(bottomEdge(cells)));
    assert.equal(round(cells.get('root').w), round(rightEdge(cells)));
    assert.equal(nodes.a.side, 'up');
  });

  test('gaps keep their meaning on the turned table', () => {
    const top = layoutFor('top');
    const root = top.cells.get('root'), a = top.cells.get('a'), b = top.cells.get('b');
    assert.equal(round(a.y - (root.y + root.h)), OPTS.colGap, 'colGap separates depth rows');
    assert.equal(round(b.x - (a.x + a.w)), OPTS.rowGap, 'rowGap separates sibling blocks');
    const bottom = layoutFor('bottom');
    assert.equal(
      round(bottom.cells.get('root').y - (bottom.cells.get('a').y + bottom.cells.get('a').h)),
      OPTS.colGap
    );
  });

  test('an unknown side falls back to the left form', () => {
    const fallback = layoutFor('sideways');
    const left = layoutFor('left');
    assert.deepEqual(fallback.nodes, left.nodes);
    assert.deepEqual([...fallback.cells], [...left.cells]);
  });
});

describe('rootSide - config and preset plumbing', () => {
  test('validateLayoutConfig keeps a known side and defaults to left', () => {
    assert.equal(fns.validateLayoutConfig({ treetable: { rootSide: 'right' } }).treetable.rootSide, 'right');
    assert.equal(fns.validateLayoutConfig({ treetable: { rootSide: 'sideways' } }).treetable.rootSide, 'left');
    assert.equal(fns.validateLayoutConfig(null).treetable.rootSide, 'left');
  });

  test('validateLayoutParams accepts only the four sides', () => {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      assert.deepEqual(fns.validateLayoutParams('treetable', { rootSide: side }), { rootSide: side });
    }
    assert.deepEqual(fns.validateLayoutParams('treetable', { rootSide: 'diagonal' }), {});
  });

  test('a preset side survives, and a saved map config wins over it', () => {
    assert.equal(fns.layoutRunForMap('treetable', null, null).params.rootSide, 'left');
    assert.equal(fns.layoutRunForMap('treetable', { rootSide: 'top' }, null).params.rootSide, 'top');
    assert.equal(fns.layoutRunForMap(
      'treetable', { rootSide: 'top' }, { treetable: { rootSide: 'bottom' } }
    ).params.rootSide, 'bottom');
  });

  test('an imported preset can pin the side', () => {
    const preset = fns.validateLayoutPreset({
      v: 1, id: 'tt-top', name: 'Tree table top', strategy: 'treetable',
      params: { colGap: 40, rowGap: 10, rootSide: 'top' },
    });
    assert.equal(preset.params.rootSide, 'top');
    assert.equal(preset.params.colGap, 40);
    assert.equal(fns.layoutRunForMap(preset.strategy, preset.params, null).params.rootSide, 'top');
  });

  test('the side travels in a share link', () => {
    const p = fns._shareePayload({
      title: 'T', rootId: 'r', nodes: {}, layout: 'treetable',
      layoutParams: { colGap: 64, rowGap: 16, rootSide: 'right' },
    });
    assert.deepEqual(p.layoutParams, { colGap: 64, rowGap: 16, rootSide: 'right' });
  });
});
