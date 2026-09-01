// The Content-Security-Policy is written in three places, because no single one
// covers every deployment:
//
//   server.js         - response header, local SQLite mode only
//   public/_headers   - response header, Cloudflare Workers/Pages
//   public/index.html - <meta>, the ONLY one GitHub Pages honours
//
// GitHub Pages is precisely the deployment that keeps a GitHub token in
// localStorage and cannot send headers, so the <meta> copy is load-bearing:
// script-src with no external host and an allowlisted connect-src are what stop
// an injected script from posting that token to an attacker's origin. Three
// hand-maintained copies drift silently - a stale one still parses, still
// enforces, and just quietly permits an origin the others dropped. So the
// deltas between them are enumerated here and everything else must match.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/** "a 'b'; c d" -> { a: ["'b'"], c: ["d"] } */
function parse(policy) {
  const out = {};
  for (const part of policy.split(';').map(s => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    out[name] = values;
  }
  return out;
}

/** server.js builds its CSP as an array of directive strings - join them back. */
function serverPolicy() {
  const src = read('server.js');
  const at = src.indexOf("res.setHeader('Content-Security-Policy'");
  assert.notEqual(at, -1, 'server.js no longer sets a Content-Security-Policy header');
  const body = src.slice(at, src.indexOf('].join', at));
  return [...body.matchAll(/"([^"]+)"/g)].map(m => m[1]).join('; ');
}

const metaPolicy = () => {
  const m = read('public', 'index.html')
    .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, 'index.html has no Content-Security-Policy <meta> tag');
  return m[1];
};

const headersPolicy = () => {
  const m = read('public', '_headers').match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  assert.ok(m, 'public/_headers has no Content-Security-Policy line');
  return m[1].trim();
};

// The Worker origin the static builds talk to for OAuth and live collaboration.
// Server mode disables both (collabAvailable() requires MODE==='cloud'), which
// is why server.js legitimately omits these two.
const WORKER_ONLY = [
  'https://mindspark-oauth.githubpage.workers.dev',
  'wss://mindspark-oauth.githubpage.workers.dev',
];

describe('Content-Security-Policy stays in sync across the three deployments', () => {
  test('every fetch directive matches, apart from the Worker origin', () => {
    const meta = parse(metaPolicy());
    const headers = parse(headersPolicy());
    const server = parse(serverPolicy());

    for (const dir of Object.keys(meta)) {
      assert.deepEqual(headers[dir], meta[dir],
        `public/_headers and index.html disagree on ${dir}`);

      if (dir === 'connect-src') {
        assert.deepEqual(server[dir], meta[dir].filter(v => !WORKER_ONLY.includes(v)),
          'server.js connect-src should equal the meta list minus the Worker origin');
      } else {
        assert.deepEqual(server[dir], meta[dir],
          `server.js and index.html disagree on ${dir}`);
      }
    }
  });

  test('the token cannot be scripted or posted off-origin', () => {
    const meta = parse(metaPolicy());
    // No external script host: an attacker cannot load their exfiltration
    // payload, only inline it (which sanitizeInlineHTML is there to stop).
    assert.deepEqual(meta['script-src'], ["'self'", "'unsafe-inline'"]);
    assert.ok(!meta['script-src'].includes("'unsafe-eval'"), 'unsafe-eval re-enables string-to-code');
    // connect-src must stay an allowlist - a wildcard would make the rest moot.
    assert.ok(meta['connect-src'] && meta['connect-src'].length > 1);
    for (const v of meta['connect-src']) {
      assert.ok(v === "'self'" || /^(https|wss):\/\/[a-z0-9.-]+$/.test(v),
        `connect-src entry "${v}" is not a bare https/wss origin`);
    }
    assert.deepEqual(meta['default-src'], ["'self'"]);
    assert.deepEqual(meta['object-src'], ["'none'"]);
    assert.deepEqual(meta['base-uri'], ["'self'"]);
  });

  test('frame-ancestors lives only where it is honoured', () => {
    // Ignored in <meta> by spec, so asserting it there would be a false comfort.
    assert.ok(!metaPolicy().includes('frame-ancestors'),
      'frame-ancestors is ignored in <meta>; put it in _headers/server.js');
    assert.ok(headersPolicy().includes("frame-ancestors 'none'"));
    assert.ok(serverPolicy().includes("frame-ancestors 'none'"));
  });

  test('every origin the app actually calls is allowed by connect-src', () => {
    const allowed = new Set(parse(metaPolicy())['connect-src']);
    const app = read('public', 'app.js');
    const providers = read('public', 'quote-providers.json');
    const called = new Set();
    for (const m of app.matchAll(/fetch\(\s*[`'"](https:\/\/[a-z0-9.-]+)/g)) called.add(m[1]);
    for (const m of providers.matchAll(/"url":\s*"(https:\/\/[a-z0-9.-]+)/g)) called.add(m[1]);
    for (const origin of called) {
      assert.ok(allowed.has(origin), `${origin} is fetched by the app but missing from connect-src`);
    }
  });
});
