// The shipped layout library (layouts/*.json).
//
// These files are meant to be copied by other people, so a broken one is worse
// than a missing one: it teaches the wrong schema. This checks each file
// survives validation with nothing silently dropped, and actually places a map.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'layouts');

const fns = loadFns(
  ['validateLayoutConfig', 'validateLayoutParams', 'validateLayoutPreset',
   'resolveLayout', 'layoutTree', 'layoutChain', 'layoutRadial', 'layoutGrid', 'layoutMatrix', 'layoutTreeTable'],
  {
    LAYOUT_PARAMS: extractConst('LAYOUT_PARAMS'),
    ENGINE_PARAMS: extractConst('ENGINE_PARAMS'),
    LAYOUT_ENGINES: extractConst('LAYOUT_ENGINES'),
    LAYOUT_CONFIG_DEFAULTS: extractConst('LAYOUT_CONFIG_DEFAULTS'),
    LAYOUT_CONFIG_BOUNDS: extractConst('LAYOUT_CONFIG_BOUNDS'),
  }
);
// Must list every strategy: a missing entry makes the lookup undefined and the
// failure look like a broken layout file rather than a stale test.
const ENGINES = {
  tree: fns.layoutTree, chain: fns.layoutChain,
  radial: fns.layoutRadial, grid: fns.layoutGrid, matrix: fns.layoutMatrix,
  treetable: fns.layoutTreeTable,
};

test('the engine map covers every strategy the app declares', () => {
  for (const strategy of Object.keys(extractConst('LAYOUT_PARAMS'))) {
    assert.ok(ENGINES[strategy], `this test file has no engine for "${strategy}"`);
  }
});

const FILES = readdirSync(DIR).filter(f => f.endsWith('.json'));
const TREE = { root:['a','b','c'], a:['a1','a2'], b:[], c:['c1'], a1:[], a2:[], c1:[] };
const buildNodes = () => {
  const nodes = {};
  for (const id of Object.keys(TREE)) {
    nodes[id] = { id, w: id === 'root' ? 140 : 120, h: id === 'root' ? 50 : 40, x:0, y:0 };
  }
  return nodes;
};

describe('shipped layout library', () => {
  test('there are layouts to ship', () => {
    assert.ok(FILES.length > 0, 'layouts/ contains no JSON files');
  });

  for (const file of FILES) {
    const raw = JSON.parse(readFileSync(join(DIR, file), 'utf8'));

    test(`${file}: passes the same validation an import does`, () => {
      assert.ok(fns.validateLayoutPreset(raw), 'would be rejected on import');
    });

    test(`${file}: no declared parameter is silently dropped`, () => {
      // A dropped key means the file documents something the schema does not
      // accept - exactly the way a published example teaches the wrong thing.
      const p = fns.validateLayoutPreset(raw);
      for (const key of Object.keys(raw.params || {})) {
        assert.notEqual(p.params[key], undefined, `"${key}" was dropped by validation`);
      }
    });

    test(`${file}: actually places a map`, () => {
      const p = fns.validateLayoutPreset(raw);
      const run = fns.resolveLayout(p.strategy || p.engine, p.params);
      const nodes = buildNodes();
      ENGINES[run.strategy](nodes, 'root', id => TREE[id] || [], run.params);
      for (const [id, n] of Object.entries(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${id} was not placed`);
      }
      assert.ok(Object.values(nodes).some(n => n.x !== 0 || n.y !== 0), 'nothing moved');
    });
  }

  test('ids are unique, so importing the whole library does not overwrite entries', () => {
    const ids = FILES.map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')).id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('none collides with a built-in id, which import refuses', () => {
    const builtins = new Set(extractConst('BUILTIN_LAYOUTS').map(b => b.id));
    for (const file of FILES) {
      const { id } = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
      assert.ok(!builtins.has(id), `${file} uses the built-in id "${id}"`);
    }
  });

  test('every strategy the app implements has at least one example', () => {
    const covered = new Set(FILES.map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')).strategy));
    for (const strategy of Object.keys(extractConst('LAYOUT_PARAMS'))) {
      assert.ok(covered.has(strategy), `no example layout uses the "${strategy}" strategy`);
    }
  });
});
