// MindSpark's collaboration (live sessions + cloud-shared maps) is reached
// through a backend. Upstream's hosted build uses the Cloudflare worker named
// in GH_OAUTH.workerUrl. But collaboration does not have to come from that
// worker: a companion that serves this app and answers /healthz with
// {"mode":"collab"} is the backend on its own origin, so a self-hosted MindSpark
// (any forge) can offer collaboration without the GitHub OAuth worker at all.
//
// These tests pin the discovery and the single resolver every collab call must
// go through, so the worker URL is never reached for a companion (which would
// send a non-GitHub token to the maintainer's infrastructure) and the hosted
// build stays byte-for-byte unchanged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

// Build callable copies of the discovery + resolver against injected globals.
function load({ health, hostname = 'maps.example.org', origin = 'https://maps.example.org', oauth = null }) {
  const calls = { fetched: [] };
  const location = { hostname, origin, href: origin + '/', hash: '' };
  const document = { baseURI: origin + '/' };
  const fetch = async (url) => {
    calls.fetched.push(url);
    if (health == null) throw new TypeError('offline');
    return { ok: health.ok !== false, status: health.status || 200,
      clone(){ return this; }, async json(){ if (health.body === undefined) throw new Error('no json'); return health.body; } };
  };
  const GH_OAUTH = oauth || { clientId: '', workerUrl: '', appOrigin: '' };
  // oauthConfigured is lifted from source so the resolver's fallback is the real one.
  const src = [
    "const appUrl = path => new URL(path, document.baseURI).href;",
    extract('const COLLAB ='),
    extract('function probeHealth('),
    "let _healthProbe=null;",              // reset per load (declared in source too; harmless shadow via var scope below)
    extract('function oauthConfigured('),
    extract('function collabBase('),
    extract('function collabAvailable('),
    "return { probeHealth, collabBase, collabAvailable, COLLAB, setMode:(m)=>{MODE=m;} };",
  ].join('\n');
  let MODE = 'cloud';
  const factory = new Function('fetch', 'location', 'document', 'GH_OAUTH', 'MODE_INIT', `let MODE=MODE_INIT; let _healthProbe=null;\n${src.replace('let _healthProbe=null;\n','')}`);
  const api = factory(fetch, location, document, GH_OAUTH, MODE);
  return { ...api, calls };
}
function extract(decl) {
  // grabs a top-level function/const declaration by brace or semicolon matching
  const i = APP.indexOf(decl); assert.notEqual(i, -1, 'not found: ' + decl);
  if (decl.startsWith('const')) { const end = APP.indexOf('\n', APP.indexOf('};', i) !== -1 ? APP.indexOf('};', i) : APP.indexOf(';', i)); return APP.slice(i, end); }
  // function: brace match
  let depth = 0, started = false;
  for (let j = APP.indexOf('{', i); j < APP.length; j++) { const c = APP[j]; if (c === '{'){ depth++; started = true; } else if (c === '}'){ depth--; if (started && depth === 0) return APP.slice(i, j + 1); } }
  throw new Error('no end for ' + decl);
}

describe('collab backend discovery', () => {
  test('a companion answering {"mode":"collab"} becomes the backend on this origin', async () => {
    const { probeHealth, COLLAB, calls } = load({ health: { body: { mode: 'collab' } } });
    const r = await probeHealth();
    assert.equal(r, 'collab');
    assert.equal(COLLAB.url, 'https://maps.example.org');
    assert.match(calls.fetched[0], /\/healthz$/);
  });

  test('a plain node server (/healthz ok, no collab mode) is NOT a collab backend', async () => {
    const { probeHealth, COLLAB } = load({ health: { body: { mode: 'server' } } });
    assert.equal(await probeHealth(), 'server');
    assert.equal(COLLAB.url, '');
  });

  test('no /healthz (static hosting) discovers nothing', async () => {
    const { probeHealth, COLLAB } = load({ health: null });
    assert.equal(await probeHealth(), null);
    assert.equal(COLLAB.url, '');
  });

  test('the probe is done once and shared', async () => {
    const { probeHealth, calls } = load({ health: { body: { mode: 'collab' } } });
    await Promise.all([probeHealth(), probeHealth(), probeHealth()]);
    assert.equal(calls.fetched.length, 1, 'one /healthz for the whole boot');
  });
});

describe('collabBase resolver', () => {
  test('a discovered companion wins, and the worker URL is never used', async () => {
    const { probeHealth, collabBase } = load({
      health: { body: { mode: 'collab' } },
      oauth: { clientId: 'x', workerUrl: 'https://worker.example/', appOrigin: 'https://maps.example.org' } });
    await probeHealth();
    assert.equal(collabBase(), 'https://maps.example.org', 'the companion origin, not the worker');
  });

  test('with no companion, the configured GitHub worker is the backend (hosted build unchanged)', () => {
    const { collabBase } = load({
      health: null,
      oauth: { clientId: 'x', workerUrl: 'https://worker.example/', appOrigin: 'https://maps.example.org' } });
    assert.equal(collabBase(), 'https://worker.example/');
  });

  test('no companion and no configured worker means no backend', () => {
    const { collabBase } = load({ health: null });
    assert.equal(collabBase(), '');
  });
});

describe('every collab call goes through collabBase (source)', () => {
  const body = (name) => { const i = APP.indexOf(name); const s = APP.slice(i, i + 400); return s; };
  test('wsUrl builds from collabBase, not GH_OAUTH.workerUrl', () => {
    assert.match(body('function wsUrl('), /collabBase\(\)/);
    assert.doesNotMatch(body('function wsUrl('), /GH_OAUTH\.workerUrl/);
  });
  test('sharedApiUrl builds from collabBase', () => {
    assert.match(body('function sharedApiUrl('), /collabBase\(\)/);
    assert.doesNotMatch(body('function sharedApiUrl('), /GH_OAUTH\.workerUrl/);
  });
  test('the session mint posts to collabBase, so a forge token never reaches the GitHub worker', () => {
    const i = APP.indexOf('async ensure()'); const s = APP.slice(i, i + 900);
    assert.match(s, /collabBase\(\)/);
    assert.doesNotMatch(s, /GH_OAUTH\.workerUrl/);
  });
  test('collabAvailable is true whenever a backend resolves, in cloud mode', () => {
    assert.match(body('function collabAvailable('), /collabBase\(\)/);
  });
  test('boot awaits the health probe before a #live= guest join', () => {
    const probe = APP.indexOf('await probeHealth()');
    const live = APP.indexOf('if(await tryEnterLiveSession())');
    assert.ok(probe !== -1 && live !== -1 && probe < live, 'probeHealth() must run before tryEnterLiveSession()');
  });
});
