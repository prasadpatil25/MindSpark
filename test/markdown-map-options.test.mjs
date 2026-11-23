// Markdown frontmatter can configure the map, not just describe the document.
// The two accepted blocks are nested `mindspark:` and `markmap:`: a top-level
// `layout:` belongs to a static-site page or a Claude Skill and must not be
// mistaken for a map setting. markmap's spellings are aliases onto this app's
// registries, and its explicit fold comments / initialExpandLevel let the
// source decide what starts collapsed instead of the importer collapsing all.
//
// The control block is also stripped before the visible Field | Value table is
// built, or a nested block would be flattened into one unreadable row and
// re-exported as corrupted YAML.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const RE = { INLINE_HTML_RE: extractConst('INLINE_HTML_RE'), ENTITY_RE: extractConst('ENTITY_RE') };
const REGISTRIES = {
  LAYOUT_ENGINES: extractConst('LAYOUT_ENGINES'),
  MAP_STYLES: extractConst('MAP_STYLES'),
  THEMES: extractConst('THEMES'),
  LOOKS: extractConst('LOOKS'),
};

function lift(extra = {}) {
  let n = 0;
  return loadFns(
    ['parseMarkdownOutline', 'stripIndent', 'parseMapOptionsFrontmatter', 'mapOptionsForMap', 'foldMapForLevel',
     'mdInlineToHtml', 'escapeHtml', 'metaFingerprint', 'parseFrontmatterFields', 'frontmatterFieldsToHtml'],
    { uid: () => 'p' + (++n), ...RE, ...REGISTRIES, ...extra });
}
function parse(md, extra) {
  return lift(extra).parseMarkdownOutline(md, 'Test');
}
function byText(m, text) {
  return Object.values(m.nodes).find(n => n.text === text);
}

describe('frontmatter map options', () => {
  test('mindspark: layout, style and foldLevel become map fields', () => {
    const m = parse(`---
title: Roadmap
owner: Ana
mindspark:
  layout: radial
  style: neon
  foldLevel: 2
---
# Plan
## Phase 1
### Task A
#### Step 1
## Phase 2
`);
    assert.equal(m.layout, 'radial');
    assert.equal(m.style, 'neon');
    assert.equal(m._foldDeclared, true, 'a foldLevel must count as a declared fold state');

    // Root depth 0, Phase 1 depth 1: foldLevel 2 collapses Task A (depth 2,
    // which has a child) but leaves its parent expanded.
    assert.ok(!byText(m, 'Plan').collapsed);
    assert.ok(!byText(m, 'Phase 1').collapsed);
    assert.ok(byText(m, 'Task A').collapsed);
    assert.ok(!byText(m, 'Phase 2').collapsed);
  });

  test('the control block never reaches the visible Field | Value table', () => {
    const m = parse(`---
title: Roadmap
mindspark:
  layout: radial
  style: neon
---
# Plan
`);
    const fm = Object.values(m.nodes).find(n => n.frontmatter);
    assert.ok(fm, 'the remaining frontmatter should still be a visible node');
    assert.match(fm.html, /Roadmap/);
    assert.doesNotMatch(fm.html, /mindspark|foldLevel|radial|neon/);
    assert.match(m.frontmatter, /title: Roadmap/);
    assert.doesNotMatch(m.frontmatter, /mindspark/);
  });

  test('a frontmatter block holding only controls leaves no empty table node', () => {
    const m = parse(`---
markmap:
  tree: org-chart
  theme: cards
  colorScheme: dark
  initialExpandLevel: 0
---
# Root
- Child
`);
    assert.equal(Object.values(m.nodes).filter(n => n.frontmatter).length, 0);
    assert.equal(m.frontmatter, undefined);
    assert.equal(m.layout, 'down', 'markmap tree: org-chart is this app\'s down layout');
    assert.equal(m.style, 'modern', 'markmap theme: cards is this app\'s modern style');
    assert.deepEqual(m._mdAppearance, { look: undefined, theme: 'dark' });
    assert.ok(m.nodes[m.rootId].collapsed, 'initialExpandLevel 0 collapses the root');
  });

  test('markmap aliases do not override a mindspark value', () => {
    const m = parse(`---
mindspark:
  layout: left
  style: minimal
markmap:
  tree: org-chart
  theme: cards
---
# R
- A
`);
    assert.equal(m.layout, 'left');
    assert.equal(m.style, 'minimal');
  });

  test('a top-level layout is document metadata, not a map setting', () => {
    const m = parse(`---
layout: post
theme: dark
---
# R
- A
`);
    assert.equal(m.layout, undefined);
    assert.equal(m.style, undefined);
    assert.equal(m._mdAppearance, undefined);
  });

  test('an unknown value falls back instead of corrupting the map', () => {
    const m = parse(`---
mindspark:
  layout: sideways
  style: glass
  look: nope
  theme: nope
  foldLevel: many
---
# R
- A
`);
    assert.equal(m.layout, undefined);
    assert.equal(m.style, undefined);
    assert.equal(m._mdAppearance, undefined);
    assert.equal(m._foldDeclared, undefined);
  });

  test('a custom layout preset resolves to its engine', () => {
    const preset = { id: 'my-map', engine: 'radial' };
    const m = parse(`---
mindspark:
  layout: my-map
---
# R
- A
`, { findLayout: id => id === 'my-map' ? preset : null });
    assert.equal(m.layoutPreset, 'my-map');
    assert.equal(m.layout, 'radial');
  });
});

describe('markmap fold markers', () => {
  test('the inline label form is markmap\'s documented placement', () => {
    const m = parse(`# R
- A <!-- markmap: fold -->
  - A1
- B
`);
    assert.equal(m._foldDeclared, true);
    assert.equal(byText(m, 'A').collapsed, true);
    assert.equal(byText(m, 'A').text, 'A', 'the directive must not stay in the label');
    assert.ok(!byText(m, 'B').collapsed);
  });

  test('an inline heading marker works and leaves no trailing whitespace', () => {
    const m = parse(`# R
## A <!-- markmap: fold -->
### A1
## B
`);
    assert.equal(byText(m, 'A').collapsed, true);
    assert.equal(byText(m, 'A').text, 'A');
  });

  test('inline foldAll folds the whole map like the standalone marker', () => {
    const m = parse(`# R
## A <!-- markmap: foldAll -->
### A1
## B
- B1
`);
    assert.equal(m._foldDeclared, true);
    assert.ok(byText(m, 'R').collapsed);
    assert.ok(byText(m, 'A').collapsed);
    assert.ok(byText(m, 'B').collapsed);
  });

  test('a node that merely mentions markmap keeps its text', () => {
    const m = parse('# R\n- markmap is useful\n');
    assert.equal(m._foldDeclared, undefined);
    assert.equal(byText(m, 'markmap is useful').text, 'markmap is useful');
  });

  test('<!-- markmap: fold --> collapses the node it sits under', () => {
    const m = parse(`# Root
- A
  <!-- markmap: fold -->
  - A1
- B
`);
    assert.equal(m._foldDeclared, true);
    assert.ok(byText(m, 'A').collapsed);
    assert.ok(!byText(m, 'A1').collapsed);
    assert.ok(!byText(m, 'B').collapsed);
  });

  test('foldAll collapses every branch that has children', () => {
    const m = parse(`# Root
- A
  - A1
    - A2
      <!-- markmap: foldAll -->
- B
  - B1
`);
    assert.equal(m._foldDeclared, true);
    assert.ok(byText(m, 'A').collapsed);
    assert.ok(byText(m, 'A1').collapsed);
    assert.ok(!byText(m, 'A2').collapsed, 'a leaf has nothing to fold');
    assert.ok(byText(m, 'B').collapsed);
  });

  test('a marker is consumed, never rendered as a node', () => {
    const m = parse(`# Root
- A
  <!-- markmap: fold -->
`);
    assert.equal(byText(m, '<!-- markmap: fold -->'), undefined);
    assert.equal(Object.values(m.nodes).filter(n => /markmap/.test(n.text || '')).length, 0);
  });

  test('no declaration leaves the importer free to collapse everything', () => {
    const m = parse('# R\n- A\n- B\n');
    assert.equal(m._foldDeclared, undefined);
    assert.ok(!byText(m, 'A').collapsed);
  });

  test('per-node collapsed meta also counts as a declaration', () => {
    const m = parse(`<!-- mindspark
{"v":1,"nodes":{"0.0":{"collapsed":true,"t":"a"}}}
-->
# R
- a
- b
`);
    assert.equal(m._foldDeclared, true);
    assert.ok(byText(m, 'a').collapsed);
    assert.ok(!byText(m, 'b').collapsed);
  });
});

describe('map layout and style ride the mindspark meta comment', () => {
  test('layout, layoutPreset and style survive a Markdown round trip', () => {
    const map = {
      rootId: 'r', title: 'Styled', layout: 'radial', layoutPreset: 'my-preset', style: 'neon',
      color: '#e0613a',
      nodes: {
        r: { id: 'r', text: 'Root', parent: null, side: 'root', x: 0, y: 0 },
        c: { id: 'c', text: 'Child', parent: 'r', side: 'right', x: 0, y: 0 },
      },
    };
    const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
    const built = loadFns(
      ['buildMarkdown', '_nodeMeta', 'metaFingerprint', 'escapeHtml', 'nodeTextPlain',
       'htmlToInlineMd', 'notesToMdBlocks', 'frontmatterNodeToYaml'],
      { map, childrenOf, hasInlineMarkup: () => false, ...RE }).buildMarkdown('r', { rich: true, meta: true });
    assert.match(built, /"layout":"radial"/);
    assert.match(built, /"layoutPreset":"my-preset"/);
    assert.match(built, /"style":"neon"/);

    const back = parse(built);
    assert.equal(back.layout, 'radial');
    assert.equal(back.layoutPreset, 'my-preset');
    assert.equal(back.style, 'neon');
  });
});
