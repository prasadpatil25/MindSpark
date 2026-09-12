// Boots the real server.js (zero dependencies: node:http + node:sqlite) on a
// free port with a throwaway database and talks to it over HTTP. Covers what
// CI asserts by curl - the shell, app code and API all answer 200 - plus the
// map API round trip and the body check: a PUT whose body was not a JSON
// object used to be stored as the literal, which broke the next list load.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let proc, base, dir;

async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not come up: ' + url);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mindspark-test-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(base + '/healthz');
});

after(async () => {
  if (proc) { proc.kill(); await new Promise(r => proc.once('exit', r)); }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const json = (method, path, body) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

describe('self-hosted server', () => {
  test('serves the shell, the app code and the API (what CI checks with curl)', async () => {
    for (const p of ['/', '/app.js', '/styles.css', '/api/maps']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
  });

  test('a map round-trips through PUT, GET, list and DELETE', async () => {
    const m = { title: 'Round trip', color: '#3a6ea5', rootId: 'r', nodes: { r: { id: 'r', text: 'R', parent: null } }, links: [] };
    assert.equal((await json('PUT', '/api/maps/t1', m)).status, 200);
    const got = await (await fetch(base + '/api/maps/t1')).json();
    assert.equal(got.title, 'Round trip');
    assert.equal(got.id, 't1', 'the URL id wins');
    const list = await (await fetch(base + '/api/maps')).json();
    assert.ok(list.some(x => x.id === 't1' && x.color === '#3a6ea5'));
    assert.equal((await fetch(base + '/api/maps/t1', { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(base + '/api/maps/t1')).status, 404);
  });

  test('a body that is not a JSON object is rejected instead of stored', async () => {
    for (const body of [5, null, 'text', [1, 2]]) {
      const r = await json('PUT', '/api/maps/bad', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await json('POST', '/api/maps', 7)).status, 400);
    assert.equal((await fetch(base + '/api/maps/bad')).status, 404, 'nothing was stored');
  });

  test('POST without an id is still a 400', async () => {
    assert.equal((await json('POST', '/api/maps', { title: 'no id' })).status, 400);
  });

  test('static files never escape the public folder', async () => {
    const r = await fetch(base + '/../server.js');
    assert.notEqual(r.status, 200);
    assert.notEqual((await fetch(base + '/%2e%2e/server.js')).status, 200);
  });
});

// A custom LLM provider lives on an origin the shipped Content-Security-Policy
// does not list. A self-hoster allows it with EXTRA_CONNECT_SRC, and it has to
// reach BOTH policies the browser enforces: the response header and the <meta>
// tag inside index.html (the browser applies the intersection, so a header
// alone would leave the meta blocking the request). Appended, never replaced.
describe('EXTRA_CONNECT_SRC', () => {
  let p2, base2, dir2;
  before(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'mindspark-csp-'));
    const port = 30000 + Math.floor(Math.random() * 20000);
    base2 = `http://127.0.0.1:${port}`;
    p2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir2, 'test.db'), EXTRA_CONNECT_SRC: 'http://localhost:11434 https://api.mistral.ai junk-not-an-origin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(base2 + '/healthz');
  });
  after(async () => {
    if (p2) { p2.kill(); await new Promise(r => p2.once('exit', r)); }
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('the header and the served meta tag both gain the origins; malformed entries are ignored', async () => {
    const r = await fetch(base2 + '/');
    const header = r.headers.get('content-security-policy');
    const html = await r.text();
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    for (const policy of [header, meta]) {
      const connect = policy.match(/connect-src ([^;]+)/)[1];
      assert.match(connect, /https:\/\/api\.github\.com/, 'the shipped list is still there');
      assert.match(connect, /http:\/\/localhost:11434/);
      assert.match(connect, /https:\/\/api\.mistral\.ai/);
      assert.doesNotMatch(connect, /junk/);
    }
    assert.equal((header.match(/connect-src/g) || []).length, 1);
    const js = await (await fetch(base2 + '/app.js')).text();
    assert.equal(js, readFileSync(join(ROOT, 'public', 'app.js'), 'utf8'), 'only the HTML is rewritten; scripts are served byte for byte');
  });
});
