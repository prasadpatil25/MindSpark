// The +/- handle on a node toggles `collapsed`. render() reuses a node's element
// whenever its signature is unchanged, so the element outlives the node object
// it was built from: undo/redo (restore), Markdown-mode sync (applyMdToMap), a
// collab snapshot and a cloud merge all swap map.nodes for fresh objects. A
// handler that captured the original object then toggled a detached copy and
// the map showed nothing - "sometimes the +/- does nothing". The handler has to
// look the node up by id at click time.
//
// render() needs the whole DOM, so the handler line is lifted out of its real
// source and driven directly; the CSS sweep below covers the "any look, style or
// layout" half of the question.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

/** The collapse handle's click handler, as written in render(). */
function handlerSource() {
  const render = extractFunction('render');
  const m = render.match(/^\s*(\(\)=>\{[^\n]*collapsed=![^\n]*\})\s*$/m);
  assert.ok(m, 'collapse handler not found in render()');
  return m[1];
}

function harness() {
  const calls = [];
  const map = { id: 'm', rootId: 'r', nodes: {
    r: { id: 'r', text: 'Root', parent: null },
    a: { id: 'a', text: 'A', parent: 'r' },
    b: { id: 'b', text: 'B', parent: 'a' },
  } };
  const n = map.nodes.a;   // what render() had in hand when it built the element
  // `n` is passed too so the pre-fix handler (which closed over it) compiles as
  // well - that is what lets this test demonstrate the old failure.
  const click = new Function('map', 'id', 'n', 'pushHistory', 'autoLayout', 'return ' + handlerSource())(
    map, 'a', n, () => calls.push('pushHistory'), () => calls.push('autoLayout'));
  return { map, n, click, calls };
}

describe('collapse handle - toggles the live node', () => {
  test('toggles and re-lays out on a plain click', () => {
    const h = harness();
    h.click();
    assert.equal(h.map.nodes.a.collapsed, true);
    assert.deepEqual(h.calls, ['pushHistory', 'autoLayout']);
    h.click();
    assert.equal(h.map.nodes.a.collapsed, false);
  });

  test('still works after map.nodes was replaced under a reused element (undo/redo, md sync, merge)', () => {
    const h = harness();
    // Exactly what restore() does: new objects, same ids, same content.
    h.map.nodes = JSON.parse(JSON.stringify(h.map.nodes));
    h.click();
    assert.equal(h.map.nodes.a.collapsed, true, 'the node on the map must change');
    assert.equal(h.n.collapsed, undefined, 'the detached object the element was built from is not the target');
    assert.deepEqual(h.calls, ['pushHistory', 'autoLayout']);
  });

  test('does nothing, and records no history, if the node is gone', () => {
    const h = harness();
    delete h.map.nodes.a;
    assert.doesNotThrow(() => h.click());
    assert.deepEqual(h.calls, []);
  });
});

describe('collapse handle - reachable in every look, map style and UI layout', () => {
  // Every rule whose selector mentions the handle. Only edit mode and
  // presentation mode may hide it; nothing keyed on a look, a map style or a
  // UI layout is allowed to hide it, make it non-interactive or shrink it away.
  const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments would bleed into selectors
  const rules = [...plain.matchAll(/([^{}]*?(?:\.handle|\.h-collapse)[^{}]*)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

  test('the handle rules exist', () => {
    assert.ok(rules.some(r => r.sel === '.node .h-collapse'), 'base .h-collapse rule');
    assert.ok(rules.length >= 5);
  });

  test('no look, map style or UI layout hides or disables the handle', () => {
    const disabling = /display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none|width\s*:\s*0|height\s*:\s*0|opacity\s*:\s*0(?![.\d])/;
    const allowed = /\.node\.editing|body\.presenting|body\.shared-view \.handle\.h-(child|sibling)|\.node \.handle\{|\.node \.handle$/;
    for (const r of rules) {
      if (!disabling.test(r.body)) continue;
      // `.node .handle{opacity:0}` is the resting state that hover reveals;
      // the collapse handle overrides it with its own opacity, checked below.
      assert.match(r.sel, allowed, `"${r.sel}" hides or disables the handle`);
      assert.doesNotMatch(r.sel, /data-look|data-style|ui-[a-z]+|data-theme/, `"${r.sel}" is keyed on a look/style/layout/theme`);
    }
  });

  test('the collapse handle is visible at rest, not only on hover', () => {
    const base = rules.find(r => r.sel === '.node .h-collapse');
    const op = base.body.match(/opacity\s*:\s*([\d.]+)/);
    assert.ok(op && Number(op[1]) > 0, 'resting opacity must be > 0 so it can be found without hovering');
    // Stacking comes from the shared .handle rule.
    const shared = rules.find(r => r.sel === '.node .handle');
    assert.match(shared.body, /z-index\s*:\s*[1-9]/, 'handle sits above the card and any ::after decoration');
  });
});
