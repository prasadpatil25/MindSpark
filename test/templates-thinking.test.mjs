// The Thinking tools template category.
//
// Templates are data, so a typo in a parent key or a duplicated node key would
// not throw at load time - it would silently create an orphan or a rootless
// map. These checks read the shipped templates.js, the same source the app
// loads, and exercise every node in the category.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractConst } from './helpers/load-app-fns.mjs';

const TEMPLATES = extractConst('TEMPLATES');
const TEMPLATE_CATEGORIES = extractConst('TEMPLATE_CATEGORIES');
const LAYOUT_ENGINES = extractConst('LAYOUT_ENGINES');

const THINKING_IDS = ['six_hats', 'scamper', 'pre_mortem', 'five_whys', 'toulmin', 'belief_audit'];

describe('Thinking tools templates', () => {
  test('the category exists once and has a label and icon', () => {
    const matches = TEMPLATE_CATEGORIES.filter(c => c.id === 'thinking');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].label, 'Thinking tools');
    assert.ok(matches[0].icon);
  });

  test('the six expected templates are in the category', () => {
    const ids = Object.entries(TEMPLATES)
      .filter(([, t]) => t.group === 'thinking')
      .map(([id]) => id);
    assert.deepEqual(ids.sort(), [...THINKING_IDS].sort());
  });

  for (const id of THINKING_IDS) {
    describe(id, () => {
      const tpl = TEMPLATES[id];

      test('has the metadata the picker renders and a known layout', () => {
        assert.ok(tpl, `${id} is missing`);
        assert.ok(tpl.name && tpl.desc && tpl.icon);
        assert.ok(LAYOUT_ENGINES.includes(tpl.layout), `unknown layout: ${tpl.layout}`);
      });

      test('has exactly one root and every parent resolves', () => {
        const keys = new Set(tpl.nodes.map(n => n.k));
        assert.equal(keys.size, tpl.nodes.length, 'duplicate node keys');
        const roots = tpl.nodes.filter(n => !n.parent);
        assert.equal(roots.length, 1, `expected one root, found ${roots.length}`);
        for (const n of tpl.nodes) {
          if (n.parent) assert.ok(keys.has(n.parent), `${n.k} points at missing parent ${n.parent}`);
        }
      });

      test('carries at least one trigger question in the notes', () => {
        assert.ok(
          tpl.nodes.some(n => typeof n.notes === 'string' && n.notes.includes('?')),
          'no node note contains a question'
        );
      });

      test('contains no em dash or smart quotes', () => {
        const text = JSON.stringify(tpl);
        for (const ch of ['\u2014', '\u2018', '\u2019', '\u201c', '\u201d']) {
          assert.ok(!text.includes(ch), `contains forbidden character ${JSON.stringify(ch)}`);
        }
      });
    });
  }
});
