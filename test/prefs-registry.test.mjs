// The Preferences card shows, resets and exports what this browser remembers,
// and it can only do that for keys the PREFS registry knows. So the registry
// must not drift from the code: this walks every 'mindspark:...' literal in
// public/app.js - static keys and the prefix of dynamic ones - and asserts a
// row covers it. Add a setting without a row and this fails, the way
// looks-registry fails for a look the export painter cannot paint.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');

const PREFS = extractConst('PREFS');
const PREFS_QUOTA = extractConst('PREFS_QUOTA');

function withStore(pairs) {
  const store = new Map(Object.entries(pairs));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const fns = loadFns(['prefsRowFor', 'prefsEntries', 'prefsBytes', 'prefsFormatBytes', 'prefsExportable', 'prefsImportable', 'prefsUnwrap', 'removePrefs'],
    { PREFS, PREFS_QUOTA, localStorage });
  return { ...fns, store };
}

/** Every 'mindspark:...' key the app writes, as a representative concrete key. */
function keysInSource() {
  const out = new Map();
  const re = /'mindspark:([A-Za-z:._-]*)'(\+[A-Za-z_.$()[\]]+)?(?:\+'([A-Za-z:._-]*)')?/g;
  let m;
  while ((m = re.exec(APP))) {
    const base = 'mindspark:' + m[1];
    const dynamic = !!m[2];
    // The bare prefix on its own is the scanner in prefsEntries()/showPreferences
    // (`k.startsWith('mindspark:')`), not a key.
    if (base === 'mindspark:' && !dynamic) continue;
    const rep = dynamic ? base + 'x' + (m[3] || '') : base;
    const line = APP.slice(0, m.index).split('\n').length;
    if (!out.has(rep)) out.set(rep, line);
  }
  return out;
}

describe('PREFS registry covers every key the app writes', () => {
  const { prefsRowFor } = withStore({});
  const keys = keysInSource();

  test('the scan finds the keys it is meant to (sanity)', () => {
    for (const k of ['mindspark:theme', 'mindspark:llm:key:x', 'mindspark:backup:x', 'mindspark:x:token', 'mindspark:layouts']) {
      assert.ok(keys.has(k), 'scanner missed ' + k);
    }
    assert.ok(keys.size >= 30, 'expected a few dozen keys, found ' + keys.size);
  });

  for (const [key, line] of keys) {
    test(`${key} (app.js:${line}) has a registry row`, () => {
      assert.ok(prefsRowFor(key), `no PREFS row covers ${key} - add one (or a transient row) so the Preferences card can account for it`);
    });
  }

  test('every row has a kind the dialog understands, and visible rows have a label', () => {
    for (const r of PREFS) {
      assert.ok(['pref', 'content', 'secret', 'session', 'cache', 'transient'].includes(r.kind), JSON.stringify(r));
      assert.ok(r.key || r.prefix || r.re, 'row matches nothing: ' + JSON.stringify(r));
      if (r.kind !== 'transient') assert.ok(r.label && r.section, 'visible row needs label and section: ' + (r.key || r.prefix || r.re));
    }
  });
});

describe('export / import / reset derive from the registry', () => {
  const sample = {
    'mindspark:theme': 'dark',
    'mindspark:look': 'lab',
    'mindspark:llm:model:anthropic': 'claude-opus-5',
    'mindspark:llm:key:anthropic': 'sk-secret',
    'mindspark:gh:token': 'ghp_secret',
    'mindspark:gitlab:refresh': 'r-secret',
    'mindspark:forge': 'github',
    'mindspark:forge:repo': 'team/maps',
    'mindspark:custom-theme': '{"id":"t","name":"Mine","vars":{}}',
    'mindspark:userTemplates': '[{"id":"u1","name":"Plan"}]',
    'mindspark:backup:m1': '{"id":"m1"}',
    'mindspark:view:m1': '{"x":1}',
    'mindspark:oauth:state': 'nonce',
  };

  test('export carries choices and content, never a credential, session or cache', () => {
    const { prefsExportable } = withStore(sample);
    const out = prefsExportable();
    assert.deepEqual(Object.keys(out).sort(), [
      'mindspark:custom-theme', 'mindspark:llm:model:anthropic', 'mindspark:look', 'mindspark:theme', 'mindspark:userTemplates',
    ]);
    const dumped = JSON.stringify(out);
    for (const secret of ['sk-secret', 'ghp_secret', 'r-secret', 'nonce', 'team/maps']) assert.ok(!dumped.includes(secret), secret + ' leaked into the export');
    // JSON kept as a string in storage is written as real JSON in the file,
    // so it can be read and hand-edited; scalars stay the strings they are.
    assert.deepEqual(out['mindspark:custom-theme'], { id: 't', name: 'Mine', vars: {} });
    assert.deepEqual(out['mindspark:userTemplates'], [{ id: 'u1', name: 'Plan' }]);
    assert.equal(out['mindspark:theme'], 'dark');
  });

  test('scalars are never unwrapped, even when they happen to parse as JSON', () => {
    const { prefsUnwrap } = withStore({});
    for (const v of ['1', '0', '0.8', 'true', 'null', 'dark', '', '[not json', '{"a":1']) assert.equal(prefsUnwrap(v), v, JSON.stringify(v));
    assert.deepEqual(prefsUnwrap(' {"a":1}'), { a: 1 });
    assert.deepEqual(prefsUnwrap('[]'), []);
  });

  test('import keeps known choices and content, drops secrets, unknown keys and unusable shapes', () => {
    const { prefsImportable } = withStore({});
    const got = prefsImportable({ app: 'mindspark', v: 2, prefs: {
      'mindspark:theme': 'nord', 'mindspark:llm:key:openai': 'sk-x', 'mindspark:gh:token': 't', 'evil': 'x',
      'mindspark:userTemplates': '[]', 'mindspark:uiScale': 1.2, 'mindspark:backup:m': '{}',
      'mindspark:tabs': true, 'mindspark:look': null,
    } });
    assert.deepEqual(got, { 'mindspark:theme': 'nord', 'mindspark:userTemplates': '[]', 'mindspark:uiScale': '1.2' });
    assert.deepEqual(prefsImportable({ 'mindspark:look': 'lab' }), { 'mindspark:look': 'lab' }, 'a bare object of keys is accepted too');
    assert.equal(prefsImportable(null), null);
    assert.equal(prefsImportable([1]), null);
    assert.equal(prefsImportable('nope'), null);
  });

  test('a v2 file (real JSON values) and a v1 file (strings) both restore to what storage holds', () => {
    const h = withStore(sample);
    const exported = h.prefsExportable();                 // v2 shape
    const back = h.prefsImportable({ app: 'mindspark', v: 2, prefs: exported });
    for (const k of Object.keys(exported)) assert.equal(back[k], sample[k], k + ' must restore byte-for-byte');
    const v1 = h.prefsImportable({ app: 'mindspark', v: 1, prefs: { 'mindspark:custom-theme': sample['mindspark:custom-theme'] } });
    assert.equal(v1['mindspark:custom-theme'], sample['mindspark:custom-theme']);
    assert.deepEqual(h.prefsImportable({ 'mindspark:prefs:folds': { ai: false } }), { 'mindspark:prefs:folds': '{"ai":false}' }, 'a hand-written object is stored as its JSON text');
  });

  test('reset preferences removes choices only; sign-in, content and backups stay', () => {
    const h = withStore(sample);
    const gone = h.removePrefs(['pref']);
    assert.deepEqual(gone.sort(), ['mindspark:llm:model:anthropic', 'mindspark:look', 'mindspark:theme']);
    for (const keep of ['mindspark:gh:token', 'mindspark:forge', 'mindspark:custom-theme', 'mindspark:userTemplates', 'mindspark:backup:m1']) {
      assert.ok(h.store.has(keep), keep + ' must survive a preferences reset');
    }
  });

  test('entries and sizes', () => {
    const h = withStore(sample);
    const backups = h.prefsEntries(h.prefsRowFor('mindspark:backup:x'));
    assert.deepEqual(backups, [['mindspark:backup:m1', '{"id":"m1"}']]);
    assert.equal(h.prefsBytes(backups), ('mindspark:backup:m1'.length + '{"id":"m1"}'.length) * 2, 'UTF-16: two bytes a character');
    assert.equal(h.prefsFormatBytes(512), '512 B');
    assert.equal(h.prefsFormatBytes(1536), '1.5 KB');
    assert.equal(h.prefsFormatBytes(PREFS_QUOTA), '5.00 MB');
  });
});

describe('the card is reachable', () => {
  test('a preferences button sits beside the palette button and is wired', () => {
    assert.match(HTML, /id="themeBtn"[^\n]*\n\s*<button class="tb" id="prefsBtn"/);
    assert.match(APP, /\$\('#prefsBtn'\)\?\.addEventListener\('click', showPreferences\)/);
  });

  test('the card builds its rows with DOM calls, not innerHTML', () => {
    const at = APP.indexOf('function showPreferences(');
    const end = APP.slice(at).search(/\r?\n\}\r?\n/);   // first top-level close after the function starts
    const body = APP.slice(at, at + end);
    // The one innerHTML is the reset of the container; everything else is textContent.
    assert.equal((body.match(/innerHTML\s*=/g) || []).length, 1);
    assert.match(body, /body\.innerHTML=''/);
  });

  test('styles exist for the sections, rows, chips and meter', () => {
    for (const cls of ['.pf-section', '.pf-row', '.pf-chip', '.pf-meter', '.pf-meter-bar.warn']) assert.ok(CSS.includes(cls + '{'), cls);
  });
});

// Step 2: the Appearance rows are controls. They must change state through
// the same functions the palette panel and the chrome use, so a choice made
// on the card lands and persists exactly as it would anywhere else. Two of
// those functions were inline click handlers before and are lifted here.
describe('appearance controls share their apply functions', () => {
  function dom() {
    const classes = new Set();
    const body = { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); return classes.has(c); }, contains: c => classes.has(c) } };
    const els = {};
    const mk = id => (els[id] = els[id] || { id, title: '', cls: new Set(),
      classList: { toggle(c, on) { on ? this.owner.cls.add(c) : this.owner.cls.delete(c); }, contains(c) { return this.owner.cls.has(c); } } });
    for (const id of ['overview', 'overviewToggle', 'zenPin']) { const e = mk(id); e.classList.owner = e; }
    const store = new Map();
    const localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
    const document = { body, getElementById: id => els[id] || null };
    const $ = sel => els[sel.slice(1)] || null;
    return { body, els, store, localStorage, document, $, classes };
  }

  test('setOverviewCollapsed drives the card, the chevron title and storage; the chevron toggles through it', () => {
    const d = dom();
    const { setOverviewCollapsed, isOverviewCollapsed } = loadFns(['setOverviewCollapsed', 'isOverviewCollapsed'], { $: d.$, localStorage: d.localStorage });
    setOverviewCollapsed(true);
    assert.equal(isOverviewCollapsed(), true);
    assert.equal(d.els.overviewToggle.title, 'Expand overview');
    assert.equal(d.store.get('mindspark:overviewCollapsed'), '1');
    setOverviewCollapsed(false);
    assert.equal(isOverviewCollapsed(), false);
    assert.equal(d.store.get('mindspark:overviewCollapsed'), '0');
    assert.match(APP, /\$\('#overviewToggle'\)\?\.addEventListener\('click',\(\)=>setOverviewCollapsed\(!isOverviewCollapsed\(\)\)\)/);
  });

  test('setZenPinned works with or without the pin button present; the pin routes through it', () => {
    const d = dom();
    const { setZenPinned } = loadFns(['setZenPinned'], { document: d.document, localStorage: d.localStorage });
    setZenPinned(true);
    assert.ok(d.classes.has('zen-pinned'));
    assert.equal(d.store.get('mindspark:zenPinned'), '1');
    assert.ok(d.els.zenPin.cls.has('on'));
    assert.equal(d.els.zenPin.title, 'Unpin toolbar');
    delete d.els.zenPin;   // any layout but zen
    setZenPinned(false);
    assert.ok(!d.classes.has('zen-pinned'));
    assert.equal(d.store.get('mindspark:zenPinned'), '0');
    assert.match(APP, /pin\.addEventListener\('click',\(\)=>setZenPinned\(!document\.body\.classList\.contains\('zen-pinned'\)\)\)/);
  });

  test('the card applies every appearance choice through the shared function', () => {
    const at = APP.indexOf('function showPreferences(');
    const end = APP.slice(at).search(/\r?\n\}\r?\n/);
    const body = APP.slice(at, at + end);
    for (const fn of ['applyTheme', 'applyLook', 'applyUiLayout', 'setUiScale', 'setUiScaleAuto', 'setOverviewCollapsed', 'setZenPinned', 'setTabsEnabled']) {
      assert.ok(body.includes(fn), 'Preferences card does not use ' + fn);
    }
    // Never a private write of a key another function owns.
    assert.doesNotMatch(body, /localStorage\.setItem\('mindspark:(theme|look|uiLayout|uiScale|tabs|zenPinned|overviewCollapsed)'/);
  });
});

// The card first shipped calling loadUserTemplates(), which merges the saved
// templates into the catalog and returns nothing - so the preferences button
// threw on ".length" and opened nothing. userTemplateList() is the one reader
// for that key; the card and both template helpers go through it.
describe('saved templates are read through userTemplateList()', () => {
  const load = store => loadFns(['userTemplateList'], { localStorage: { getItem: k => store[k] ?? null } }).userTemplateList;

  test('returns the stored list, or [] for nothing, junk or a non-array', () => {
    assert.deepEqual(load({ 'mindspark:userTemplates': '[{"id":"a","name":"A"}]' })(), [{ id: 'a', name: 'A' }]);
    assert.deepEqual(load({})(), []);
    assert.deepEqual(load({ 'mindspark:userTemplates': '{not json' })(), []);
    assert.deepEqual(load({ 'mindspark:userTemplates': '{"id":"a"}' })(), []);
  });

  test('the card and the template helpers all use it; the card never calls the merge-only loader', () => {
    for (const fn of ['showPreferences', 'deleteUserTemplate', 'loadUserTemplates']) {
      assert.match(extractFunction(fn), /userTemplateList\(\)/, fn);
    }
    assert.doesNotMatch(extractFunction('showPreferences'), /loadUserTemplates\(/);
  });
});

// Sections fold. Which start open comes from the room the card has (in CSS
// pixels after the interface scale), the user's remembered folds win once
// they have touched a section, and a section with something to act on opens
// once regardless. Browser runs at 1366x900, 1024x700 and 400x800 confirmed
// the same outcomes; this pins the decision table itself.
describe('preferences sections: fold policy', () => {
  const load = store => loadFns(['prefsDefaultOpen', 'prefsSectionOpen', 'prefsFolds', 'prefsSaveFold'], {
    PREFS_FOLDS_KEY: 'mindspark:prefs:folds',
    PREFS_SECTIONS_MEDIUM: extractConst('PREFS_SECTIONS_MEDIUM'),
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
  });
  const ALL = ['storage', 'account', 'ai', 'sharing', 'content', 'appearance', 'everything'];

  test('tall window: everything open; laptop: the three people come for; short or narrow: nothing', () => {
    const { prefsDefaultOpen } = load({});
    assert.deepEqual(ALL.filter(id => prefsDefaultOpen(id, 1100, 1600)), ALL);
    assert.deepEqual(ALL.filter(id => prefsDefaultOpen(id, 875, 1280)), ['storage', 'account', 'appearance']);
    assert.deepEqual(ALL.filter(id => prefsDefaultOpen(id, 550, 1280)), []);
    assert.deepEqual(ALL.filter(id => prefsDefaultOpen(id, 1000, 500)), [], 'a phone is tall in CSS px but narrow: rows wrap, so fold');
  });

  test('a remembered fold beats the size rule and a forced open; a forced open beats the size rule', () => {
    const { prefsSectionOpen } = load({});
    const phone = { h: 1000, w: 500 };
    assert.equal(prefsSectionOpen('storage', {}, phone, new Set()), false);
    assert.equal(prefsSectionOpen('storage', {}, phone, new Set(['storage'])), true, 'nearly-full storage opens once');
    assert.equal(prefsSectionOpen('storage', { storage: false }, phone, new Set(['storage'])), false, 'the user folded it deliberately');
    assert.equal(prefsSectionOpen('ai', { ai: true }, phone, new Set()), true);
  });

  test('folds persist per section and survive junk in storage', () => {
    const store = {};
    const { prefsFolds, prefsSaveFold } = load(store);
    assert.deepEqual(prefsFolds(), {});
    prefsSaveFold('ai', false); prefsSaveFold('appearance', true);
    assert.deepEqual(JSON.parse(store['mindspark:prefs:folds']), { ai: false, appearance: true });
    store['mindspark:prefs:folds'] = '[1,2]';
    assert.deepEqual(prefsFolds(), {});
    store['mindspark:prefs:folds'] = '{broken';
    assert.deepEqual(prefsFolds(), {});
  });

  test('the fold key is a preference: reset clears it, export carries it', () => {
    const h = withStore({ 'mindspark:prefs:folds': '{"ai":false}' });
    assert.deepEqual(h.prefsExportable(), { 'mindspark:prefs:folds': { ai: false } });   // written as real JSON, see prefsUnwrap
    assert.deepEqual(h.removePrefs(['pref']), ['mindspark:prefs:folds']);
  });

  test('every section is a <details> with a digest, and the card settles the folds after building', () => {
    const at = APP.indexOf('function showPreferences(');
    const end = APP.slice(at).search(/\r?\n\}\r?\n/);
    const body = APP.slice(at, at + end);
    assert.match(body, /el\('details','pf-section'\)/);
    for (const id of ALL) assert.ok(body.includes("digest('" + id + "',"), id + ' has no digest');
    assert.match(body, /settle\(\);\r?\n\s*\};/, 'settle() runs last in render()');
    assert.match(body, /addEventListener\('toggle'/, 'user toggles are remembered');
  });
});
