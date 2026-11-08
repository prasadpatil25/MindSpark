// Shared machinery for walking public/styles.css as a cascade and measuring
// text-on-surface contrast the way a browser would composite it.
//
// Used by test/breadcrumb-contrast.test.mjs (the crumb-specific audit) and
// test/color-contrast.test.mjs (theme token invariants plus the whole-sheet
// sweep). Everything here reads the real stylesheet: no snapshot, no copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractConst } from './load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- rule parsing (depth-aware so @media/@supports keeps its prefix) ---------- */
function parse(src) {
  const out = []; let sel = ''; let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const bs = ++i; let d = 1;
      while (i < src.length && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; }
      const body = src.slice(bs, i - 1); const s = sel.trim().replace(/\s+/g, ' ');
      if (s.startsWith('@media') || s.startsWith('@supports')) {
        if (/print/i.test(s)) { sel = ''; continue; }   // printed output is out of scope
        for (const r of parse(body)) out.push({ sel: s + ' ' + r.sel, body: r.body });
      } else if (!s.startsWith('@')) out.push({ sel: s, body });
      sel = '';
    } else if (ch === '}') { i++; sel = ''; } else { sel += ch; i++; }
  }
  return out;
}
export const RULES = parse(CSS);
// source order is half of the cascade; the tie-break in winDecl compares it
RULES.forEach((r, i) => { r.i = i; });

export function decls(body) {
  const d = {};
  for (const part of body.split(';')) {
    const k = part.indexOf(':'); if (k < 0) continue;
    // `background:transparent !important` is a colour value, not a colour plus
    // decoration. Left intact it failed to parse and the rule fell through to
    // the "gradient" path, measuring a transparent paint against the base as
    // though the two were different surfaces.
    const v = part.slice(k + 1).trim().replace(/\s*!important\s*$/i, '');
    d[part.slice(0, k).trim()] = v;
  }
  return d;
}

/* ---------- specificity, same model as the breadcrumb test ---------- */
export function spec(sel) {
  const s = sel.replace(/::[\w-]+/g, ' ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+/g) || []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
  const pseudos = (s.match(/:[\w-]+/g) || []).length;
  const rest = s.replace(/\[[^\]]*\]/g, ' ').replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ').replace(/:[\w-]+/g, ' ').replace(/[>+~,()]/g, ' ');
  const types = rest.split(/\s+/).filter(Boolean).length;
  return [ids, cls + attrs + pseudos, types];
}
export const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/* ---------- colour maths ---------- */
const NAMED = { black: '#000000', white: '#ffffff', transparent: 'transparent' };
export function parseColor(expr, vars, depth = 0) {
  if (depth > 20) throw new Error('var() cycle in ' + expr);
  const e = String(expr).trim().replace(/;$/, '');
  if (e === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const vm = e.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (vm) {
    if (vm[1] in vars) return parseColor(vars[vm[1]], vars, depth + 1);
    if (vm[2]) return parseColor(vm[2], vars, depth + 1);
    return null;
  }
  const mm = e.match(/^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/);
  if (mm) {
    const parts = splitTop(mm[1]);
    const a = parsePart(parts[0], vars, depth), b = parsePart(parts[1], vars, depth);
    const pa = a.pct / 100;
    // premultiplied by alpha then un-premultiplied, the way CSS composites a mix
    const alpha = pa * a.alpha + (1 - pa) * b.alpha;
    const rgb = a.rgb.map((c, i) => (c * a.alpha * pa + b.rgb[i] * b.alpha * (1 - pa)) / (alpha || 1));
    return { rgb, alpha };
  }
  // rgb() / rgba() in both the legacy comma form and the modern space-plus-slash
  // form. styles.css uses these 325 times (panel washes, modal backdrops, hover
  // tints); without them every ancestor that paints one looks like it paints
  // nothing and the surface chain dies there.
  const rm = e.match(/^rgba?\(([^)]*)\)$/i);
  if (rm) {
    const parts = rm[1].replace(/\//g, ' ').trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 3 && parts.length <= 4) {
      const chan = s => (s.endsWith('%') ? parseFloat(s) * 2.55 : parseFloat(s));
      const pct = s => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));
      const rgb = parts.slice(0, 3).map(chan);
      const alpha = parts.length === 4 ? pct(parts[3]) : 1;
      if (rgb.every(Number.isFinite) && Number.isFinite(alpha)) {
        return { rgb: rgb.map(n => Math.max(0, Math.min(255, n))), alpha: Math.max(0, Math.min(1, alpha)) };
      }
    }
  }
  const c = hexColor(NAMED[e] || e);
  if (c) return { rgb: c, alpha: 1 };
  return null;   // gradients and url() are not audited; callers treat null as "unresolved"
}
function parsePart(p, vars, depth) {
  let pct = 100; let s = String(p).trim();
  const pm = s.match(/^(.*?)\s+(-?[\d.]+)%$/);
  if (pm) { pct = parseFloat(pm[2]); s = pm[1].trim(); }
  const c = parseColor(s, vars, depth) || { rgb: [0, 0, 0], alpha: 0 };
  return { rgb: c.rgb, alpha: c.alpha, pct };
}
function splitTop(s) {
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') d++; else if (ch === ')') d--;
    if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  if (out.length !== 2) throw new Error('color-mix needs two operands: ' + s);
  return out;
}
function hexColor(s) {
  s = s.trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return null;
  let h = s.slice(1);
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const over = (top, bottom) => top.rgb.map((c, i) => c * top.alpha + bottom[i] * (1 - top.alpha));
export const relLum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export function contrast(a, b) {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ---------- themes and looks ---------- */
// A theme is every base :root declaration with that theme's own
// :root[data-theme=...] declarations laid over it. Specificity decides, not
// source order, so a base rule applies however late it sits: the notes-editor
// :root{--sticky} block is hundreds of lines below the first theme rule, and
// seeding a theme from THEMES.light at its first appearance (which is what
// this did) drops that block for every theme defined before it - 20 light
// themes looked like they had no --sticky at all.
const baseRules = [], themeRules = [];
for (const r of RULES) {
  if (r.sel === ':root') baseRules.push(r);
  for (const p of r.sel.split(',').map(x => x.trim())) {
    const t = p.match(/^:root\[data-theme="([^"]+)"\]$/);
    if (t) themeRules.push([t[1], r]);
  }
}
const baseVars = {};
for (const r of baseRules) Object.assign(baseVars, decls(r.body));
const themeVars = {};
for (const [name, r] of themeRules) {
  if (!themeVars[name]) themeVars[name] = {};
  Object.assign(themeVars[name], decls(r.body));
}
export const THEMES = { light: { ...baseVars, ...(themeVars.light || {}) } };
for (const [name, o] of Object.entries(themeVars)) {
  if (name !== 'light') THEMES[name] = { ...baseVars, ...o };
}
export const LOOK_VARS = {};
for (const r of RULES) {
  const l = r.sel.match(/^:root\[data-look="([^"]+)"\]$/);
  if (l) LOOK_VARS[l[1]] = decls(r.body);
}
export const LOOKS = extractConst('LOOKS').map(l => l.id);   // office first, the neutral base
export const varsFor = (look, theme) => ({ ...THEMES[theme], ...(LOOK_VARS[look] || {}) });
export const appliesToLook = (sel, look) => {
  const m = sel.match(/data-look="([^"]+)"/);
  return !m || m[1] === look;
};

/* ---------- element identity ----------
   A selector is split into the element it styles (core) plus the state
   conditions it demands (hover / editing). `:root[data-look=...]` prefixes are
   stripped from the core so look-scoped rules compete in the same cascade as
   the base rules they override, but specificity still counts the full selector. */
export function elementOf(sel) {
  // Generated content is out of scope, and styles.css spells it both ways.
  // Only `::` was checked, so the legacy single-colon `.login-steps > li:before`
  // reached the sweep and was reported as though it were the panel's real text.
  if (sel.includes('::') || /:(before|after|first-letter|first-line|marker)\b/.test(sel)) return null;
  if (sel === ':root' || /data-theme=/.test(sel)) return null;
  let s = sel.replace(/^:root\[data-look="[^"]+"\]\s*/, '');
  const cond = {};
  if (/:hover\b/.test(s)) { cond.hover = true; s = s.replace(/:hover\b/g, ''); }
  if (/\[contenteditable="true"\]/.test(s)) { cond.edit = true; s = s.replace(/\[contenteditable="true"\]/g, ''); }
  if (/:(active|focus|focus-visible|focus-within|visited|checked|disabled|empty|target|read-only)\b/.test(s)) return null;
  if (/:not\(/.test(s)) return null;
  const parts = s.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!parts.length) return null;
  return { core: parts.join(' '), cond };
}
export const condMatches = (cond, state) => {
  // A :hover rule applies only while hovering; a plain rule applies in every
  // state and simply loses the tie-break to the more specific :hover rule.
  // This used to demand `!!cond.hover !== !!state.hover`, which threw every
  // plain declaration out of the hover state - so the sweep measured hover
  // rules with no base background or base colour underneath them.
  if (cond.hover && !state.hover) return false;
  if (cond.edit && !state.edit) return false;
  return true;   // plain rules also apply while editing
};
export const STATES = [
  { hover: false, edit: false }, { hover: true, edit: false },
  { hover: false, edit: true }, { hover: true, edit: true },
];

// A comma list is N independent rules that happen to share a declaration body.
// Merging them into one core produced keys like ".a, .b" that no real selector
// can ever be an ancestor of, so those rules could never inherit a surface.
function splitAlternatives(sel) {
  if (sel.startsWith('@')) return [sel];   // @media headers carry their own commas
  const out = []; let depth = 0, cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}
const ELEM = new Map();
RULES.forEach((r, i) => {
  const d = decls(r.body);
  for (const sel of splitAlternatives(r.sel)) {
    const el = elementOf(sel);
    if (!el) continue;
    if (!ELEM.has(el.core)) ELEM.set(el.core, []);
    ELEM.get(el.core).push({ sel, cond: el.cond, d, s: spec(sel), i });
  }
});
export const elements = () => ELEM;

// the declaration that wins for `core` in `state` under `look`
export function winDecl(core, state, look, props) {
  let best = null;
  for (const e of ELEM.get(core) || []) {
    if (!appliesToLook(e.sel, look)) continue;
    if (!condMatches(e.cond, state)) continue;
    if (!props.some(p => p in e.d)) continue;
    if (!best || cmpSpec(e.s, best.s) > 0 || (cmpSpec(e.s, best.s) === 0 && e.i > best.i)) best = e;
  }
  return best;
}

/* ---------- surfaces ---------- */
// `.sw.sw-clear` is also a `.sw`, and `.node.formula-error` is also a `.node`.
// Compound parts carry their own prefixes, and the shorter name is often the
// one that declares the container (or the surface entry for it). Returned
// longest-first, because a longer name is the more specific match.
function compoundPrefixes(part) {
  const segs = part.match(/[.#][\w-]+/g) || [];
  if (segs.length < 2) return [];
  const head = part.replace(/[.#][\w-]+/g, '');
  const out = [];
  for (let k = segs.length - 1; k >= 1; k--) out.push(head + segs.slice(0, k).join(''));
  return out;
}
function ancestorCores(core) {
  const parts = core.split(' ');
  const out = [];
  const push = c => { if (c && !out.includes(c)) out.push(c); };
  for (let n = parts.length - 1; n >= 1; n--) {
    push(parts.slice(0, n).join(' '));
    for (const short of compoundPrefixes(parts[n - 1])) push(short);
  }
  return out;
}
// the opaque (or composited) surface an element's ancestor chain provides.
// `state` is threaded through on purpose: hovering a child hovers its parent
// too, so `.formula-ac-row:hover{background:var(--accent)}` is the surface of
// `.formula-ac-row .formula-ac-sig` while that row is hovered. Resolving
// ancestors in the rest state always measured the hover pair against the
// container's resting surface instead.
export function surfaceOf(core, state, look, vars) {
  for (const anc of ancestorCores(core)) {
    const e = winDecl(anc, state, look, ['background', 'background-color']);
    const c = e ? parseColor(e.d.background ?? e.d['background-color'], vars) : null;
    if (c && c.alpha === 1) return { rgb: c.rgb, via: anc };
    // The ancestor paints nothing usable (no rule, background:none, a gradient)
    // or only a translucent wash. What its children sit on is what it sits on,
    // so ask behindOf(), which walks out through anc's own prefixes before
    // falling back to the surface ROOT_SURFACE has already proved for it.
    const b = behindOf(anc, state, look, vars);
    if (b) return { rgb: c ? over(c, b.rgb) : b.rgb, via: (c ? anc + ' over ' : '') + b.via };
  }
  return null;
}
// What sits behind `core`: its own ancestors first, else the surface named in
// ROOT_SURFACE. Translucent entries there are composited over the page root,
// the same way resolveBg treats them.
function behindOf(core, state, look, vars) {
  const s = surfaceOf(core, state, look, vars);
  if (s) return s;
  // The exact key first: it is the more specific statement about this element.
  // Then the shorter names it is also known by - `.sw.sw-clear` sits where
  // `.sw` sits, `.diff-h.add` where `.diff-h` sits.
  const parts = core.split(' ');
  for (const key of [core, ...compoundPrefixes(parts[parts.length - 1])
    .map(short => parts.slice(0, -1).concat(short).join(' '))]) {
    const r = ROOT_SURFACE[key];
    if (!r) continue;
    const c = parseColor(r, vars);
    if (c && c.alpha === 1) return { rgb: c.rgb, via: r };
    if (c) {
      const p = parseColor('var(--paper)', vars);
      if (p) return { rgb: over(c, p.rgb), via: r + ' over paper' };
    }
  }
  return null;
}
// Selectors whose ancestor is not part of the selector string. The value is
// the surface that element provably sits on, named so a reviewer can check it
// against the sheet. null = the element paints its own opaque background.
export const ROOT_SURFACE = {
  '.search-act': 'var(--paper-2)', '.search-count': 'var(--chrome)', '.search-toggle': 'var(--chrome)',
  '.tb.donate-btn': 'var(--chrome)', '.tb': 'var(--chrome)',
  '.tab-new': 'var(--chrome)', '.tab': 'var(--chrome)',
  '.tpl-side-hdr': 'var(--chrome)',
  '.brand h1 span': 'var(--chrome)', '.brand': 'var(--chrome)',
  '.login-signup a': 'var(--node-bg)', '.login-fallback a': 'var(--node-bg)',
  '.login-extra a': 'var(--node-bg)', '.login-brand h1 span': 'var(--node-bg)',
  '.side-links a': 'var(--chrome)', '.side-foot': 'var(--chrome)',
  '.hb-cancel': '#2d2d2d', '.hb-restore': '#2d2d2d', '.hist-banner': '#2d2d2d',
  '.save-pill': 'var(--chrome)', '.side-resize': 'var(--chrome)',
  '.pres-bar button': '#23201b', '.pres-bar': '#23201b',
  '#collabPill': 'var(--chrome)',
  '.gs-item': 'var(--chrome)', '.gs-map': 'var(--chrome)', '.gs-status': 'var(--chrome)',
  '.gs-head': 'var(--chrome)', '.gs-more': 'var(--chrome)',
  '.ol-row': 'var(--paper)', '.ol-head': 'var(--paper)',
  '.minimal-menu': 'var(--chrome)', '.minimal-sub': 'var(--chrome)',
  '#deckBar': 'var(--chrome)',
  '.zoom-val': 'var(--chrome)', '.zoom-row button': 'var(--chrome)',
  '.overview': 'var(--chrome)',
  // .formula-ac paints --chrome (styles.css:1275) and .formula-ac-row paints
  // nothing at rest, so both children sit on chrome. node-bg was a guess and
  // measured them against a surface they never touch.
  '.formula-ac-sig': 'var(--chrome)', '.formula-ac-desc': 'var(--chrome)',
  '.var-form': 'var(--node-bg)', '.vf-hint': 'var(--node-bg)',
  '.new-map': 'var(--node-bg)',
  // .theme-opt paints background:transparent (styles.css:3050) and lives in
  // .theme-panel, which paints --chrome (:2847). node-bg was wrong here.
  '.theme-opt': 'var(--chrome)', '.tp-label': 'var(--chrome)',
  '.hist-row': 'var(--node-bg)', '.user-initial': 'var(--chrome)',
  '.donate-amt': 'var(--node-bg)', '.donate-foot a': 'var(--node-bg)',
  '.instance-input': 'var(--node-bg)', '.vf-input': 'var(--node-bg)',
  '.row-pop button': 'var(--paper)', '.row-pop button.danger': 'var(--paper)',
  '.map-item': 'var(--node-bg)',
  '.hint': 'var(--chrome)', '.statusbar': 'var(--chrome)',
  '.am-rm': 'var(--node-bg)', '.am-user': 'var(--node-bg)',
  '.bp-save': 'var(--node-bg)', '.bp-chip': 'var(--node-bg)',
  '.md-prev-btn': 'var(--chrome)', '.md-wrap-btn': 'var(--chrome)',
  '.md-gutter .gl': 'var(--node-bg)',
  '.md-hl': 'var(--node-bg)', '.md-fold-chip': 'var(--node-bg)',
  '.token-input input': 'var(--node-bg)',
  '.sw-clear': 'var(--node-bg)', '.mk-custom-row input': 'var(--node-bg)',
  '.add-theme-icon': 'var(--node-bg)', '.tp-cog': 'var(--node-bg)',
  '.scale-opt': 'var(--chrome)', '.hist-actions button': '#2d2d2d',
  '.bp-row button': 'var(--node-bg)', '.vf-go': 'var(--node-bg)',
  '.shared-pill': 'var(--chrome)', '.user-pill': 'var(--chrome)',
  '.new-map-caret': 'var(--node-bg)', '#newMap': 'var(--node-bg)',
  '.vf-doi-go': 'var(--node-bg)', '.am-addbtn': 'var(--node-bg)',
  '#zenPin': 'var(--chrome)',
  '.bulk-bar button': 'var(--toolbar-bg)',
  '.bc-crumb': 'var(--chrome)', '.bc-sep': 'var(--chrome)',
  '.notes-popup': 'var(--sticky)', '.np-clear': 'var(--sticky)', '.np-editor': 'var(--sticky)',
  '.notes-popup button.primary': 'var(--sticky)',

  // The second half below covers selectors whose parent is a real DOM element
  // that the selector string does not name. `#tabRow .tab-close` never mentions
  // `.tab`, `.access-modal .am-x` never mentions `.am-card`, and a single-part
  // core has no prefix at all - so the chain can only come from here. Every
  // value is checked against the rule that paints that parent.
  '#tabRow .tab-close': 'var(--paper-2)',
  '.side-tab': 'var(--chrome)', '.side-label': 'var(--chrome)',
  '.tpl-side-item': 'var(--chrome)', '.tpl-side-meta': 'var(--chrome)',
  '.overview-toggle': 'var(--chrome)', '.search-toggle.on': 'var(--chrome)',
  '.title-edit': 'var(--chrome)',
  // #qotd paints an accent wash and sits in the side footer on chrome
  // (.qotd, styles.css:1086), so its children sit on the wash over chrome.
  '.qotd-text': 'color-mix(in srgb, var(--accent) 7%, var(--chrome))',
  '.qotd-author': 'color-mix(in srgb, var(--accent) 7%, var(--chrome))',
  '.qotd-word': 'color-mix(in srgb, var(--accent) 7%, var(--chrome))',
  '.qotd-worddef': 'color-mix(in srgb, var(--accent) 7%, var(--chrome))',
  '.qotd-refresh': 'color-mix(in srgb, var(--accent) 7%, var(--chrome))',
  '.formula-ac-row': 'var(--chrome)',   // .formula-ac, styles.css:1275
  '.node-text': 'var(--node-bg)',       // .node paints --card-bg, an alias of --node-bg
  '.sw': 'var(--toolbar-bg)',           // .swatches sits in the nodebar
  '.empty': 'var(--chrome)',            // its text lives in .e-card, styles.css:3159
  '.lib-card': 'var(--node-bg)',        // .lib-grid inside the add-a-theme card
  // .login-card, .donate-card, .vf-card, .kb-card, .bp-panel and .hist-panel
  // all paint --node-bg; .tpl-pop and .export-pop paint --chrome;
  // .diff-panel paints --paper.
  '.login-brand': 'var(--node-bg)', '.login-steps': 'var(--node-bg)',
  '.login-fallback': 'var(--node-bg)', '.login-extra': 'var(--node-bg)',
  '.login-repo': 'var(--node-bg)', '.login-token': 'var(--node-bg)',
  '.login-signup': 'var(--node-bg)', '.login-step-link': 'var(--node-bg)',
  '.login-step-hint': 'var(--node-bg)', '.login-error': 'var(--node-bg)',
  '.login-share-note': 'var(--node-bg)',
  '.pane-label': 'var(--node-bg)', '.forge-tab': 'var(--node-bg)',
  '.oauth-or': 'var(--node-bg)',
  '.donate-head': 'var(--node-bg)', '.donate-close': 'var(--node-bg)',
  '.donate-icon': 'var(--node-bg)', '.donate-label': 'var(--node-bg)',
  '.donate-back': 'var(--node-bg)',
  '.tpl-cat': 'var(--chrome)', '.tpl-item': 'var(--chrome)',
  '.pf-section': 'var(--node-bg)', '.pf-digest': 'var(--node-bg)',
  '.pf-label': 'var(--node-bg)', '.pf-value': 'var(--node-bg)',
  '.pf-chip-x': 'var(--node-bg)', '.pf-note': 'var(--node-bg)',
  '.vf-close': 'var(--node-bg)', '.vf-skip': 'var(--node-bg)',
  '.vf-clear': 'var(--node-bg)', '.vf-doi-in': 'var(--node-bg)',
  '.kb-close': 'var(--node-bg)', '.kb-foot': 'var(--node-bg)',
  '.hist-x': 'var(--node-bg)', '.hist-status': 'var(--node-bg)',
  '.hist-sub': 'var(--node-bg)', '.hist-when': 'var(--node-bg)',
  '.bp-x': 'var(--node-bg)', '.bp-text': 'var(--node-bg)',
  '.bp-meta': 'var(--node-bg)', '.bp-warn': 'var(--node-bg)',
  '.bp-run': 'var(--node-bg)',
  '.diff-x': 'var(--paper)', '.diff-empty': 'var(--paper)',
  '.diff-h': 'var(--paper)', '.diff-row': 'var(--paper)',
  '.diff-row.del': 'var(--paper)',
  '.ex-grp': 'var(--chrome)', '.map-group-label': 'var(--chrome)',
  '.collab-cursor': 'var(--paper)',   // drawn over the canvas
  // Organic nodes paint no card (background:transparent), so the word sits on
  // the canvas. Its --branch colour is written from script and reads here as
  // the --ink fallback; organic-style.test.mjs scores the real palette.
  '#viewport[data-style="organic"] .node[data-depth="1"]': 'var(--paper)',
  '.theme-panel-large': 'var(--chrome)',
  // The rows sit inside .am-card (styles.css:4248), which the selectors do not
  // name. Naming .access-modal instead would be wrong: it is a 45 percent black
  // backdrop, not the card behind the text.
  '.access-modal .am-x': 'var(--paper)',
  '.access-modal .am-lbl': 'var(--paper)',
  '.access-modal .am-role': 'var(--paper)',
  '.access-modal .am-rm': 'var(--paper)',
  '.access-modal .am-empty': 'var(--paper)',
  '.access-modal .am-vtime': 'var(--paper)',
  '.access-modal .am-foot': 'var(--paper)',
};

// Elements the sweep does not judge. Every entry is either not text at all or
// deliberately transparent; the reason is part of the contract.
export const SKIP_SEL = [
  [/\.side-resize/, 'resize grip: no text'],
  [/\.pf-meter/, 'progress meter fill: no text'],
  [/\bring\b/, 'status dot: no text'],
  [/\.notes-mark/, 'sticky-note corner glyph on its own --sticky fill: decorative'],
  [/\.node-link-fav/, 'favicon image: no text'],
  [/#mdEditor/, 'colour:transparent on purpose; the highlight layer paints the text'],
  [/\.qr-/, 'QR frame holds an image, not text'],
  [/\.tb-sep|\.bulk-sep|\.qotd-sep/, 'separator rule: no text'],
  [/::selection|::placeholder/, 'browser-painted pseudo text'],
  [/\.tpl-ic|\.tpl-side-ic/, 'template tile glyph on a per-tile inline colour: decorative'],
  // moveCursor() paints this label from the peer's own colour
  // (b.style.background = p.color, app.js:16081). No stylesheet states it.
  [/\.collab-cursor b/, 'peer name label on a per-peer colour set from script'],
  [/\.ol-twist|\.mm-caret|\.gl\b/, 'twist caret / line-gutter glyph: decorative'],
  [/\.formula-ac-row\b(?!.*(?:-sig|-desc))/, 'row wrapper: its own text lives in the children'],
  [/\.vf-sub|\.vf-name/, 'hint text measured through .vf-hint surface entry when coloured'],
];
export const isSkipped = core => SKIP_SEL.some(([re]) => re.test(core));

/* ---------- composite a rule's background over its real surface ---------- */
export function resolveBg(core, state, look, vars) {
  const paint = winDecl(core, state, look, ['background', 'background-color']);
  const base = () => behindOf(core, state, look, vars);
  if (!paint) {
    const b = base();
    return b ? { ...b, via: b.via + ' (transparent rule)' } : null;
  }
  const raw = paint.d.background ?? paint.d['background-color'];
  const c = parseColor(raw, vars);
  if (c && c.alpha === 1) return { rgb: c.rgb, via: paint.sel, raw };
  if (c) {
    const b = base();
    return b ? { rgb: over(c, b.rgb), via: paint.sel.slice(0, 70) + ' over ' + b.via, raw } : null;
  }
  const b = base();
  if (/^(none|transparent)\b/i.test(String(raw).trim())) {
    return b ? { rgb: b.rgb, via: b.via + ' (paint:none)', raw } : null;
  }
  // A gradient, an image, or a custom property written from script. The sweep
  // cannot composite it, and scoring the text against whatever the paint covers
  // would invent a pairing the app never paints: white text on an orange
  // gradient is not white text on the panel underneath it.
  return b ? { rgb: b.rgb, via: b.via + ' (unjudgeable paint)', raw, unjudgeable: true } : null;
}
