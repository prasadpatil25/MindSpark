// Pure functions lifted out of the REAL public/app.js (see helpers/load-app-fns.mjs).
// app.js is a browser script with no exports, so these are read from source
// rather than imported - which means renaming or deleting one of them fails
// here loudly instead of silently passing against a stale copy.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const { prettyUrl, pickContrast, escapeHtml, shade, edgePath, edgePathsHTML } =
  loadFns(['prettyUrl', 'pickContrast', 'escapeHtml', 'shade', 'edgePath', 'edgePathsHTML']);
const URL_RE = extractConst('URL_RE');

describe('prettyUrl - shortens link labels for display', () => {
  test('drops the scheme and a www. prefix', () => {
    assert.equal(prettyUrl('https://www.example.com'), 'example.com');
  });

  test('keeps a meaningful path but drops a trailing slash', () => {
    assert.equal(prettyUrl('https://example.com/docs/'), 'example.com/docs');
  });

  test('drops a bare root path entirely', () => {
    assert.equal(prettyUrl('https://prism.openai.com/'), 'prism.openai.com');
  });

  test('truncates very long labels with an ellipsis', () => {
    const label = prettyUrl('https://example.com/' + 'x'.repeat(120));
    assert.ok(label.length <= 44, `expected <= 44 chars, got ${label.length}`);
    assert.ok(label.endsWith('\u2026'), 'long labels end with an ellipsis');
  });

  test('returns the input unchanged when it is not a parseable URL', () => {
    assert.equal(prettyUrl('not a url'), 'not a url');
  });
});

describe('URL_RE - raw URL detection', () => {
  const matches = s => { URL_RE.lastIndex = 0; return s.match(URL_RE) || []; };

  test('finds a bare URL', () => {
    assert.deepEqual(matches('see https://example.com now'), ['https://example.com']);
  });

  test('finds several URLs in one string', () => {
    assert.equal(matches('https://a.com and https://b.com').length, 2);
  });

  test('matches http as well as https', () => {
    assert.equal(matches('http://example.com').length, 1);
  });

  test('does not match plain text without a scheme', () => {
    assert.equal(matches('example.com is not matched').length, 0);
  });

  test('stops at a closing paren so markdown-style links do not over-capture', () => {
    assert.deepEqual(matches('(https://example.com)'), ['https://example.com']);
  });
});

describe('pickContrast - readable text colour for a given background', () => {
  test('dark text on a light background', () => {
    assert.equal(pickContrast('#ffffff'), '#23201b');
    assert.equal(pickContrast('#cfe0ee'), '#23201b', 'the pastel node palette pairs with dark text');
  });

  test('light text on a dark background', () => {
    assert.equal(pickContrast('#000000'), '#ffffff');
    assert.equal(pickContrast('#23201b'), '#ffffff');
  });

  test('falls back to dark text for malformed input rather than throwing', () => {
    assert.equal(pickContrast(''), '#23201b');
    assert.equal(pickContrast(null), '#23201b');
    assert.equal(pickContrast('#abc'), '#23201b');
  });

  test('weights green more heavily than blue (per-channel luminance, not a plain average)', () => {
    // Same numeric value in the dominant channel, opposite results: green-dominant
    // #40ff40 lands at L=0.691 (dark text), blue-dominant #4040ff at L=0.336
    // (light text). A naive (r+g+b)/3 average would score both identically.
    assert.equal(pickContrast('#40ff40'), '#23201b', 'green-dominant reads as light');
    assert.equal(pickContrast('#4040ff'), '#ffffff', 'blue-dominant reads as dark');
  });
});

describe('escapeHtml', () => {
  test('escapes the characters that could break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  test('handles null and undefined without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('leaves ordinary text untouched', () => {
    assert.equal(escapeHtml('plain text 123'), 'plain text 123');
  });
});

describe('shade - lighten/darken a hex colour', () => {
  test('lightens with a positive amount and darkens with a negative one', () => {
    assert.notEqual(shade('#808080', 40), '#808080');
    assert.equal(shade('#808080', 0), '#808080');
  });

  test('clamps at white and black instead of wrapping around', () => {
    assert.equal(shade('#ffffff', 50), '#ffffff', 'must not overflow past white');
    assert.equal(shade('#000000', -50), '#000000', 'must not underflow past black');
  });

  test('always returns a full 6-digit hex colour', () => {
    for (const [c, amt] of [['#010101', -10], ['#fefefe', 10], ['#123456', 25]]) {
      assert.match(shade(c, amt), /^#[0-9a-f]{6}$/, `${c} @ ${amt}`);
    }
  });
});

describe('edgePath - branch geometry per map style', () => {
  const args = (style, horizontal = true) => edgePath(0, 0, 100, 50, false, horizontal, style);

  test('sketch draws a straight line', () => {
    assert.equal(args('sketch'), 'M0,0 L100,50');
  });

  test('classic draws right-angle elbows', () => {
    const p = args('classic');
    assert.ok(p.includes('L'), 'uses line segments');
    assert.ok(!p.includes('C'), 'classic must not emit a bezier curve');
  });

  test('modern draws a bezier curve', () => {
    assert.ok(args('modern').includes('C'));
  });

  test('bubble uses the same path shape as modern (CSS makes it thicker)', () => {
    assert.equal(args('bubble'), args('modern'));
  });

  test('an unknown style falls back to the modern curve rather than producing nothing', () => {
    assert.equal(args('no-such-style'), args('modern'));
  });

  test('every style produces a path starting at the given origin', () => {
    for (const s of ['sketch', 'classic', 'modern', 'bubble']) {
      assert.match(args(s), /^M0,0/, `style ${s}`);
    }
  });

  test('vertical layout produces a different path than horizontal', () => {
    assert.notEqual(args('classic', false), args('classic', true));
  });
});

describe('edgePathsHTML - merged edge segments become visible <path> elements', () => {
  // Keys are what drawEdges stores in its merge Map: the literal string
  // 'null|null|' for styles that defer to CSS vars, hex colours when a style
  // carries an explicit stroke.
  test('a plain (null) segment falls back to themed CSS vars, not stroke="null"', () => {
    const html = edgePathsHTML(new Map([['null|null|', 'M0,0 L10,10']]));
    assert.ok(html.includes('stroke="var(--edge-color, var(--line-2))"'), 'colour must be the CSS var');
    assert.ok(html.includes('stroke-width="var(--edge-width, 2.2)"'), 'width must be the CSS var');
    assert.ok(!html.includes('stroke="null"'), 'never emit the literal stroke="null"');
    assert.ok(!html.includes('stroke-width="null"'), 'never emit the literal stroke-width="null"');
  });

  test('an explicit colour stays explicit (custom branch colour)', () => {
    const html = edgePathsHTML(new Map([['#e0613a|null|', 'M0,0 C5,5 10,10']]));
    assert.ok(html.includes('stroke="#e0613a"'));
  });

  test('an explicit width stays explicit (minimal)', () => {
    const html = edgePathsHTML(new Map([['null|1.6|', 'M0,0 L10,10']]));
    assert.ok(html.includes('stroke-width="1.6"'));
  });

  test('a dash renders as stroke-dasharray, and absent dash emits none (dashed)', () => {
    const dashed = edgePathsHTML(new Map([['null|null|7 5', 'M0,0 L10,10']]));
    assert.ok(dashed.includes('stroke-dasharray="7 5"'));
    const solid = edgePathsHTML(new Map([['null|null|', 'M0,0 L10,10']]));
    assert.ok(!solid.includes('stroke-dasharray'));
  });

  test('every merged segment is emitted, preserving path data', () => {
    const html = edgePathsHTML(new Map([
      ['#e0613a|null|', 'M0,0 C1,1 2,2'],
      ['null|null|', 'M5,5 L6,6']
    ]));
    assert.ok(html.includes('M0,0 C1,1 2,2'));
    assert.ok(html.includes('M5,5 L6,6'));
  });

  test('every generated path is well-formed and self-closing', () => {
    const html = edgePathsHTML(new Map([
      ['null|null|', 'M0,0 L10,10'],
      ['#2aa298|null|null', 'M0,0 C1,1 2,2'],
      ['null|1.1|', 'M0,0 L20,20']
    ]));
    const paths = html.match(/<path[^>]*\/>/g) || [];
    assert.equal(paths.length, 3);
    paths.forEach(p => assert.ok(p.endsWith('/>'), `well-formed path: ${p}`));
  });
});

describe('edgePath - dashed and minimal share the modern curve geometry', () => {
  const args = (style) => edgePath(0, 0, 100, 50, false, true, style);
  const NEW_STYLES = ['dashed', 'minimal'];

  test('each new style draws a bezier curve', () => {
    for (const s of NEW_STYLES) {
      assert.ok(args(s).includes('C'), `style ${s} must emit a bezier curve`);
    }
  });

  test('new styles use the exact same path shape as modern', () => {
    for (const s of NEW_STYLES) {
      assert.equal(args(s), args('modern'), `style ${s} should match modern geometry`);
    }
  });

  test('every new style produces a path starting at the given origin', () => {
    for (const s of NEW_STYLES) {
      assert.match(args(s), /^M0,0/, `style ${s}`);
    }
  });
});

describe('edgePath - zigzag draws a jagged polyline', () => {
  const horiz = edgePath(0, 0, 96, 50, false, true, 'zigzag');
  const vert  = edgePath(0, 0, 50, 96, false, false, 'zigzag');

  test('uses only line commands - no curves', () => {
    assert.ok(!horiz.includes('C') && !vert.includes('C'), 'no bezier segments');
    assert.match(horiz, /^M0,0 /, 'starts at the given origin');
  });

  test('bounces above and below the straight axis', () => {
    const pts = [...horiz.matchAll(/L(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?= L)/g)].map(m => [+m[1], +m[2]]);
    assert.equal(pts.length, 3, 'three zigzag peaks');
    const deltas = pts.map(([x, y], i) => { const t=(i+1)/4, ey=0+(50-0)*t; return y-ey; });
    assert.ok(Math.max(...deltas.map(d => Math.abs(d))) > 0, 'at least one peak leaves the axis');
    assert.ok(deltas.every((d, i) => i % 2 === 0 ? d < 0 : d > 0), 'alternates sides');
  });

  test('vertical variant zigzags on the x axis instead', () => {
    const pts = [...vert.matchAll(/L(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?= L)/g)].map(m => [+m[1], +m[2]]);
    assert.equal(pts.length, 3);
    const deltas = pts.map(([x, y], i) => { const t=(i+1)/4, ex=0+(50-0)*t; return x-ex; });
    assert.ok(Math.max(...deltas.map(d => Math.abs(d))) > 0, 'peaks leave the x axis');
    assert.ok(deltas.every((d, i) => i % 2 === 0 ? d < 0 : d > 0), 'alternates sides');
  });

  test('ends exactly on the target point', () => {
    assert.ok(horiz.endsWith('L96,50'), 'horizontal target');
    assert.ok(vert.endsWith('L50,96'), 'vertical target');
  });

  test('amplitude clamps for long distances', () => {
    const far = edgePath(0, 0, 500, 50, false, true, 'zigzag');
    const pts = [...far.matchAll(/L(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?= L)/g)].map(m => [+m[1], +m[2]]);
    const deltas = pts.map(([x, y], i) => { const t=(i+1)/4, ey=0+(50-0)*t; return y-ey; });
    assert.ok(deltas.every(d => Math.abs(d) <= 12), 'never exceeds the 12px cap');
  });
});
