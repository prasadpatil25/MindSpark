// Organic map style (Tony Buzan's hand-drawn Mind Map). The look rests on
// three rules that live in code, not CSS: a colour per main branch inherited
// by its subtree, branches that thin out with depth, and tapered curves that
// meet the line under each word. The screen and the PNG export share these
// helpers, so pinning them here pins both.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const PALETTE = extractConst('ORGANIC_BRANCH_COLORS');
const DEFAULTS = extractConst('STYLE_CONFIG_DEFAULTS');
const MAP_STYLES = extractConst('MAP_STYLES');
const fakeMap = { rootId: 'r', nodes: {} };
const childrenOf = id => Object.values(fakeMap.nodes).filter(n => n.parent === id).map(n => n.id);

const {
  vividBranchColor, organicBranchWidth, taperedBezierPath, organicEdgePath,
  organicBranchInfo, edgePathsHTML,
} = loadFns(
  ['hex6', 'vividBranchColor', 'organicBranchWidth', 'taperedBezierPath', 'organicEdgePath',
   'zebraDepth', 'organicBranchInfo', 'edgePathsHTML'],
  {
    map: fakeMap, childrenOf, ORGANIC_BRANCH_COLORS: PALETTE,
    withChildIndex: fn => fn(), _hex6Cache: new Map(),
  }
);

// Every point of a path string, as [x, y] pairs.
const points = d => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);

describe('organic style registration', () => {
  test('is listed in the style picker and has a config section', () => {
    assert.ok(MAP_STYLES.some(s => s.id === 'organic'));
    assert.ok(DEFAULTS.organic, 'resolvedMapStyle falls back to modern without a defaults entry');
  });

  test('main branch width default sits inside the edgeWidth bounds', () => {
    const [lo, hi] = extractConst('STYLE_CONFIG_BOUNDS').edgeWidth;
    assert.ok(DEFAULTS.organic.edgeWidth >= lo && DEFAULTS.organic.edgeWidth <= hi);
  });
});

describe('organicBranchWidth - thick at the centre, thinning with depth', () => {
  test('never gets thicker as the depth grows', () => {
    let prev = Infinity;
    for (let d = 0; d <= 8; d++) {
      const w = organicBranchWidth(d, 6);
      assert.ok(w <= prev, `depth ${d}: ${w} > ${prev}`);
      prev = w;
    }
  });

  test('a main branch is exactly the configured width', () => {
    assert.equal(organicBranchWidth(1, 6), 6);
  });

  test('deep twigs keep a visible floor even with a thin base', () => {
    assert.ok(organicBranchWidth(9, 1) >= 1.2);
  });
});

describe('vividBranchColor - pale card tints become line colours', () => {
  const lightness = hex => {
    const v = parseInt(hex.slice(1), 16);
    const c = [v >> 16 & 255, v >> 8 & 255, v & 255].map(x => x / 255);
    return (Math.max(...c) + Math.min(...c)) / 2;
  };

  test('a pastel from NODE_COLORS is darkened into line range', () => {
    for (const pastel of extractConst('NODE_COLORS').slice(1)) {
      const l = lightness(vividBranchColor(pastel));
      assert.ok(l >= 0.39 && l <= 0.51, `${pastel} -> lightness ${l}`);
    }
  });

  test('keeps the hue: a pale blue stays blue', () => {
    const v = parseInt(vividBranchColor('#d8e0fb').slice(1), 16);
    assert.ok((v & 255) > (v >> 16 & 255), 'blue channel should dominate red');
  });

  test('a grey stays grey rather than gaining a hue', () => {
    const out = vividBranchColor('#eeeeee');
    assert.equal(out.slice(1, 3), out.slice(3, 5));
    assert.equal(out.slice(3, 5), out.slice(5, 7));
  });

  test('always returns #rrggbb', () => {
    for (const c of ['#fff', '#000000', '#e53935', '#123']) assert.match(vividBranchColor(c), /^#[0-9a-f]{6}$/);
  });
});

describe('taperedBezierPath - a filled outline whose width follows the taper', () => {
  test('is a closed path', () => {
    const d = taperedBezierPath([0, 0, 50, 0, 50, 100, 100, 100], 10, 2);
    assert.match(d, /^M/);
    assert.match(d, /Z$/);
  });

  test('is w1 wide at the start and w2 wide at the end', () => {
    const d = taperedBezierPath([0, 0, 50, 0, 50, 0, 100, 0], 10, 2);
    const pts = points(d);
    const half = pts.length / 2;
    const [startL, endL] = [pts[0], pts[half - 1]];
    const [endR, startR] = [pts[half], pts[pts.length - 1]];
    assert.equal(Math.abs(startL[1] - startR[1]), 10);
    assert.equal(Math.abs(endL[1] - endR[1]), 2);
  });

  test('a steep S-curve is not pinched in the middle', () => {
    // Offsetting along one axis only collapses the width where the curve runs
    // nearly parallel to that axis. The true normal keeps it.
    const d = taperedBezierPath([0, 0, 20, 0, 20, 400, 40, 400], 8, 8);
    const pts = points(d);
    const half = pts.length / 2;
    const midL = pts[Math.floor(half / 2)];
    const midR = pts[pts.length - 1 - Math.floor(half / 2)];
    assert.ok(Math.hypot(midL[0] - midR[0], midL[1] - midR[1]) > 7, 'width held through the steep part');
  });

  test('a zero-length branch still yields finite numbers', () => {
    const d = taperedBezierPath([5, 5, 5, 5, 5, 5, 5, 5], 4, 2);
    assert.ok(!/NaN|Infinity/.test(d));
  });
});

describe('organicEdgePath - branches meet the line under each word', () => {
  const p = { x: 0, y: 0, w: 100, h: 30 };
  const n = { x: 200, y: 100, w: 80, h: 24 };

  test('a sub-branch leaves the end of the parent underline and lands on the start of the child underline', () => {
    const d = organicEdgePath(p, n, { fromRoot: false, leftSide: false, horizontal: true, wp: 4, wn: 2 });
    const pts = points(d);
    const half = pts.length / 2;
    const start = [(pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2];
    const end = [(pts[half - 1][0] + pts[half][0]) / 2, (pts[half - 1][1] + pts[half][1]) / 2];
    assert.deepEqual(start, [100, 30 - 2]);   // right end of parent, centre of its 4px line
    assert.deepEqual(end, [200, 124 - 1]);    // left end of child, centre of its 2px line
  });

  test('a left-side branch mirrors the attach points', () => {
    const left = { x: -300, y: 100, w: 80, h: 24 };
    const d = organicEdgePath(p, left, { fromRoot: false, leftSide: true, horizontal: true, wp: 4, wn: 2 });
    const pts = points(d);
    const half = pts.length / 2;
    assert.equal((pts[0][0] + pts[pts.length - 1][0]) / 2, 0);
    assert.equal((pts[half - 1][0] + pts[half][0]) / 2, -220);
  });

  test('a trunk starts inside the central topic, at its middle', () => {
    const d = organicEdgePath(p, n, { fromRoot: true, leftSide: false, horizontal: true, wp: 12, wn: 6 });
    const pts = points(d);
    const sx = (pts[0][0] + pts[pts.length - 1][0]) / 2;
    const sy = (pts[0][1] + pts[pts.length - 1][1]) / 2;
    assert.ok(sx < 100 && sx > 80, `starts under the card edge, got ${sx}`);
    assert.equal(sy, 15);
  });

  test('vertical layouts keep the caller attach points', () => {
    const d = organicEdgePath(p, n, { x1: 50, y1: 30, x2: 240, y2: 100, fromRoot: false, leftSide: false, horizontal: false, wp: 4, wn: 2 });
    const pts = points(d);
    assert.equal((pts[0][0] + pts[pts.length - 1][0]) / 2, 50);
    assert.equal((pts[0][1] + pts[pts.length - 1][1]) / 2, 30);
  });
});

describe('organicBranchInfo - one colour per main branch, inherited below', () => {
  const setNodes = nodes => { fakeMap.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); };

  test('main branches take successive palette colours and children inherit', () => {
    setNodes([
      { id: 'r' }, { id: 'a', parent: 'r' }, { id: 'b', parent: 'r' },
      { id: 'a1', parent: 'a', color: '#d8e0fb' }, { id: 'a11', parent: 'a1' },
    ]);
    const { color, depth } = organicBranchInfo('');
    assert.equal(color.a, PALETTE[0]);
    assert.equal(color.b, PALETTE[1]);
    assert.equal(color.a1, PALETTE[0], 'a deeper node colour does not split the branch');
    assert.equal(color.a11, PALETTE[0]);
    assert.equal(color.r, undefined, 'the central topic is not a branch');
    assert.deepEqual([depth.r, depth.a, depth.a1, depth.a11], [0, 1, 2, 3]);
  });

  test('a main branch with its own colour keeps that hue, made line-strength', () => {
    setNodes([{ id: 'r' }, { id: 'a', parent: 'r', color: '#d8e0fb' }, { id: 'a1', parent: 'a' }]);
    const { color } = organicBranchInfo('');
    assert.equal(color.a, vividBranchColor('#d8e0fb'));
    assert.equal(color.a1, color.a);
  });

  test('white counts as no colour', () => {
    setNodes([{ id: 'r' }, { id: 'a', parent: 'r', color: '#ffffff' }]);
    assert.equal(organicBranchInfo('').color.a, PALETTE[0]);
  });

  test('an edgeColor override paints every branch one colour', () => {
    setNodes([{ id: 'r' }, { id: 'a', parent: 'r', color: '#d8e0fb' }, { id: 'b', parent: 'r' }]);
    const { color } = organicBranchInfo('#333333');
    assert.equal(color.a, '#333333');
    assert.equal(color.b, '#333333');
  });

  test('the palette wraps instead of running out', () => {
    const nodes = [{ id: 'r' }];
    for (let i = 0; i <= PALETTE.length; i++) nodes.push({ id: 'm' + i, parent: 'r' });
    setNodes(nodes);
    assert.equal(organicBranchInfo('').color['m' + PALETTE.length], PALETTE[0]);
  });
});

describe('main-branch words stay readable in their branch colour', () => {
  // The CSS paints them color-mix(branch 60%, ink) on the bare canvas, and the
  // export uses mixHex(branch, ink, 0.4). The stylesheet audit cannot see the
  // script-written --branch, so the real palette is scored here, against the
  // default theme's ink and its cream paper, the lightest common surface.
  const lum = hex => {
    const v = parseInt(hex.slice(1), 16);
    const [r, g, b] = [v >> 16 & 255, v >> 8 & 255, v & 255].map(c => {
      c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const mix = (a, b, t) => {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    return '#' + [16, 8, 0].map(s => Math.round((pa >> s & 255) * (1 - t) + (pb >> s & 255) * t)
      .toString(16).padStart(2, '0')).join('');
  };
  test('every palette colour reaches 3:1 on cream paper', () => {
    for (const c of PALETTE) {
      const fg = lum(mix(c, '#23201b', 0.4)), bg = lum('#f4efe6');
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      assert.ok(ratio >= 3, `${c}: ${ratio.toFixed(2)}`);
    }
  });
});

describe('edgePathsHTML - organic branches are filled shapes', () => {
  test('a fill segment renders filled in its colour, never stroke-only', () => {
    const html = edgePathsHTML(new Map([['#e53935|null||fill', 'M0,0 L1,1 Z']]));
    assert.ok(html.includes('fill="#e53935"'));
    assert.ok(!html.includes('fill="none"'));
  });

  test('plain stroke segments are unchanged by the fill mode', () => {
    const html = edgePathsHTML(new Map([['null|null|', 'M0,0 L10,10']]));
    assert.ok(html.includes('fill="none"'));
  });
});
