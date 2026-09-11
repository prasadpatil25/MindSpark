// Node TEXT has always gone through the sanitizer before it is drawn. The other
// node and map fields did not, and several of them reach markup: colours go
// into style attributes (sidebar dot, node toolbar), the marker glyph is
// button content, ids land in data attributes and querySelector strings, and
// the image URL is handed to window.open. A share link is the easy way in: its
// payload is decoded straight into `map`, and "Make an editable copy" saves it
// to the recipient's own store - on the static deployments, the origin that
// holds their forge token.
//
// Two layers, both asserted here: sanitizeMapData() repairs every whole map
// on the way in, and the sinks escape regardless.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractFunction, extractConst } from './helpers/load-app-fns.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

let n = 0;
const { sanitizeMapData, safeColor, safeImageUrl } = loadFns(['sanitizeMapData', 'safeColor', 'safeImageUrl'], {
  uid: () => 'fresh' + (++n),
  SAFE_COLOR_RE: extractConst('SAFE_COLOR_RE'),
  SAFE_ID_RE: extractConst('SAFE_ID_RE'),
  SAFE_IMAGE_RE: extractConst('SAFE_IMAGE_RE'),
  NODE_ALIGNS: extractConst('NODE_ALIGNS'),
});

const wellFormed = () => ({
  id: 'm1', title: 'Fine', color: '#3a6ea5', rootId: 'root',
  nodes: {
    root: { id: 'root', text: 'Root', parent: null, side: 'root', x: 0, y: 0 },
    'a-1': { id: 'a-1', text: 'A', parent: 'root', side: 'left', x: 1, y: 2, color: '#ffe2d6', textColor: 'rgba(0,0,0,.6)',
             highlight: 'transparent', marker: '\u{1F6A9}', fontSize: 18, align: 'left',
             image: 'https://example.com/a.png', notes: '<p>n</p>', collapsed: true },
    'b.2': { id: 'b.2', text: 'B', parent: 'a-1', side: 'left', x: 3, y: 4, image: 'data:image/png;base64,AAAA', task: 'todo' },
  },
  links: [{ from: 'a-1', to: 'b.2', label: 'see' }],
  vars: { k: 'v' },
});

describe('sanitizeMapData - what it leaves alone', () => {
  test('a well-formed map is returned byte-identical', () => {
    const m = wellFormed();
    const out = sanitizeMapData(JSON.parse(JSON.stringify(m)));
    assert.deepEqual(out, m);
  });

  test('every colour form the app itself writes is accepted', () => {
    for (const c of ['#fff', '#ffffff', '#e0613aCC', 'rgb(1, 2, 3)', 'rgba(0,0,0,.6)', 'hsl(200deg 40% 50% / 0.5)', 'transparent', 'red']) {
      assert.equal(safeColor(c), c, c);
    }
  });

  test('image URLs the app stores are accepted', () => {
    for (const u of ['https://x.y/a.png', 'http://x.y/a.jpg', 'data:image/png;base64,AAA', 'blob:https://x.y/uuid']) {
      assert.equal(safeImageUrl(u), u, u);
    }
  });
});

describe('sanitizeMapData - what it repairs', () => {
  test('a colour that breaks out of a style attribute falls back to the default', () => {
    const m = wellFormed();
    m.color = 'x" onmouseover="alert(1)';
    m.nodes['a-1'].color = 'red;background:url(javascript:1)';
    m.nodes['a-1'].textColor = '"><img src=x onerror=alert(1)>';
    m.nodes['a-1'].highlight = 'expression(alert(1))';
    sanitizeMapData(m);
    assert.equal(m.color, '#e0613a');
    assert.ok(!('color' in m.nodes['a-1']));
    assert.ok(!('textColor' in m.nodes['a-1']));
    assert.ok(!('highlight' in m.nodes['a-1']));
  });

  test('marker, font size and alignment are dropped unless they are the shapes the toolbar writes', () => {
    const m = wellFormed();
    Object.assign(m.nodes['a-1'], { marker: '<img src=x onerror=alert(1)>', fontSize: 'huge', align: 'evil' });
    m.nodes['b.2'].fontSize = 1e9;
    sanitizeMapData(m);
    assert.ok(!('marker' in m.nodes['a-1']));
    assert.ok(!('fontSize' in m.nodes['a-1']));
    assert.ok(!('align' in m.nodes['a-1']));
    assert.ok(!('fontSize' in m.nodes['b.2']));
  });

  test('a javascript: image URL never survives to window.open', () => {
    const m = wellFormed();
    m.nodes['a-1'].image = 'javascript:alert(document.domain)';
    m.nodes['b.2'].image = 'JAVASCRIPT:alert(1)';
    sanitizeMapData(m);
    assert.ok(!('image' in m.nodes['a-1']));
    assert.ok(!('image' in m.nodes['b.2']));
    assert.equal(safeImageUrl('javascript:alert(1)'), null);
    assert.equal(safeImageUrl('vbscript:x'), null);
  });

  test('an id that breaks an attribute or selector is re-keyed, with every reference rewritten', () => {
    const m = wellFormed();
    const bad = 'a"><img src=x onerror=alert(1)>';
    m.nodes[bad] = { id: bad, text: 'evil', parent: 'root' };
    m.nodes['c'] = { id: 'c', text: 'child of evil', parent: bad };
    m.links.push({ from: bad, to: 'c' });
    m.rootId = 'root';
    sanitizeMapData(m);
    assert.ok(!(bad in m.nodes), 'bad key gone');
    const evil = Object.values(m.nodes).find(x => x.text === 'evil');
    assert.ok(evil && /^fresh\d+$/.test(evil.id), 'got a fresh id');
    assert.equal(m.nodes[evil.id], evil, 'node stored under its new id');
    assert.equal(m.nodes.c.parent, evil.id, 'child re-parented to the new id');
    assert.ok(m.links.some(l => l.from === evil.id && l.to === 'c'), 'link rewritten');
    for (const id of Object.keys(m.nodes)) assert.equal(m.nodes[id].id, id, 'id field agrees with key');
  });

  test('a re-keyed root stays the root', () => {
    const m = { color: '#fff', rootId: 'r"', nodes: { 'r"': { text: 'R', parent: null }, k: { text: 'K', parent: 'r"' } } };
    sanitizeMapData(m);
    assert.ok(m.rootId && m.nodes[m.rootId], 'rootId points at a node');
    assert.equal(m.nodes.k.parent, m.rootId);
  });

  test('dangling parents and links are cut rather than left pointing at nothing', () => {
    const m = wellFormed();
    m.nodes['b.2'].parent = 'nope';
    m.links.push({ from: 'a-1', to: 'nope' }, null, 'junk');
    sanitizeMapData(m);
    assert.equal(m.nodes['b.2'].parent, null);
    assert.deepEqual(m.links, [{ from: 'a-1', to: 'b.2', label: 'see' }]);
  });

  test('non-object input and junk node entries do not throw', () => {
    assert.equal(sanitizeMapData(null), null);
    assert.equal(sanitizeMapData(5), null);
    assert.equal(sanitizeMapData([]), null);
    const m = sanitizeMapData({ nodes: { a: 'string', b: null, c: { text: 'ok' } }, links: 'nope' });
    assert.deepEqual(Object.keys(m.nodes), ['c']);
    assert.deepEqual(m.links, []);
    assert.deepEqual(sanitizeMapData({ nodes: [] }).nodes, {});
  });
});

describe('every map ingress runs sanitizeMapData', () => {
  for (const fn of ['loadMap', 'importFile', 'tryEnterSharedView', 'consumePendingImport', '_applySharedMap', 'adoptCloudMerged', 'normalizeLoadedMap']) {
    test(fn + '()', () => {
      assert.match(extractFunction(fn), /sanitizeMapData\(/, fn + ' must sanitize the map it takes in');
    });
  }
  test('the collab snapshot handler', () => {
    const at = APP.indexOf('function applySnapshot(');
    assert.notEqual(at, -1);
    assert.match(APP.slice(at, at + 800), /sanitizeMapData\(map\)/);
  });
});

describe('the sinks escape regardless', () => {
  const sink = (fn, re, what) => test(`${fn}: ${what}`, () => assert.match(extractFunction(fn), re));
  sink('refreshList', /style="background:\$\{escapeHtml\(m\.color/, 'sidebar dot colour');
  sink('positionNodeBar', /\$\{escapeHtml\(n\.marker/, 'marker glyph');
  sink('positionNodeBar', /solid \$\{escapeHtml\(tc\)\}/, 'text colour');
  sink('positionNodeBar', /background:\$\{escapeHtml\(hl\)\}/, 'highlight colour');
  sink('positionNodeBar', /align-\$\{escapeHtml\(n\.align/, 'alignment class');
  sink('positionNodeBar', /<span>\$\{escapeHtml\(String\(fs\)\)\}/, 'font size');
  sink('renderGlobalResults', /data-map="\$\{escapeHtml\(mid\)\}" data-node="\$\{escapeHtml\(it\.nodeId\)\}"/, 'ids in data attributes');
  sink('buildSwatchHTML', /background:\$\{escapeHtml\(t\.swatch\[0\]\)\}/, 'custom theme swatch');
  test('image double-click only opens vetted URLs, with noopener', () => {
    assert.match(extractFunction('render'), /if\(safeImageUrl\(n\.image\)\) window\.open\(n\.image,'_blank','noopener'\)/);
  });
});
