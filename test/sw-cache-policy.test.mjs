// public/sw.js decides, per request, whether a cached copy may win over the
// network. Getting that wrong does not throw - it silently pins clients to a
// stale build, which this project has already shipped once (see the header of
// sw.js). So the policy is asserted here behaviourally rather than by reading
// the regex: each case is driven through the REAL fetch handler with both a
// cache hit AND a live network available, and the test asks which one came back.
//
// Like the other tests here, this reads the shipped file rather than a copy, so
// editing the routing rules fails loudly instead of passing against a stale one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const SW = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js');
const ORIGIN = 'https://mindspark.test';

/** Evaluate sw.js against stub globals and hand back its listeners. */
function loadWorker(location = { origin: ORIGIN }) {
  const listeners = {};
  const cacheStore = new Map();
  const sandbox = {
    URL, Response, console,
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location,
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ put: async (req, res) => { cacheStore.set(keyOf(req), res); } }),
      match: async (req) => cacheStore.get(keyOf(req)),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => new Response('NETWORK', { status: 200 }),
  };
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW, 'utf8'), sandbox);
  return { listeners, cacheStore, keyOf };
}

/**
 * Ask the worker what it does for `path` when a cached copy already exists and
 * the network is also up. Returns 'NETWORK', 'CACHED', or 'passthrough' when the
 * handler declines to answer at all (browser goes to the network on its own).
 */
async function resolve(path, { navigate = false, accept = '', location } = {}) {
  const { listeners, cacheStore } = loadWorker(location);
  const url = new URL(path, ORIGIN).href;
  cacheStore.set(url, new Response('CACHED', { status: 200 }));

  const request = {
    method: 'GET', url,
    mode: navigate ? 'navigate' : 'cors',
    headers: { get: (h) => (h.toLowerCase() === 'accept' ? accept : null) },
    clone() { return this; },
  };

  let responded = null;
  listeners.fetch({ request, respondWith: (p) => { responded = p; } });
  if (responded === null) return 'passthrough';
  return (await (await responded).text());
}

describe('service worker caching policy', () => {
  describe('network-first - fixed URL, contents change on every deploy', () => {
    for (const p of ['/index.html', '/app.js', '/templates.js', '/styles.css', '/manifest.webmanifest']) {
      test(`${p} prefers the network over a cached copy`, async () => {
        assert.equal(await resolve(p), 'NETWORK');
      });
    }

    // The reason this file exists. These are shipped DATA with fixed URLs, so
    // cache-first pinned them to whatever was current when a client first
    // loaded - the same trap as app.js, one size down.
    for (const p of ['/quotes.json', '/quote-providers.json', '/demo-map.json']) {
      test(`${p} prefers the network (bundled data, not an immutable asset)`, async () => {
        assert.equal(await resolve(p), 'NETWORK');
      });
    }

    test('a navigation prefers the network', async () => {
      assert.equal(await resolve('/', { navigate: true }), 'NETWORK');
    });

    test('an Accept: text/html request prefers the network', async () => {
      assert.equal(await resolve('/some/route', { accept: 'text/html' }), 'NETWORK');
    });
  });

  describe('cache-first - only where the filename changes with the contents', () => {
    for (const p of ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/upi-qr.png']) {
      test(`${p} may be served from cache`, async () => {
        assert.equal(await resolve(p), 'CACHED');
      });
    }
  });

  describe('never touched', () => {
    test('/api/* is passed through - a stale map is worse than none', async () => {
      assert.equal(await resolve('/api/maps'), 'passthrough');
    });

    test('/healthz is passed through so the storage-mode probe stays live', async () => {
      assert.equal(await resolve('/healthz'), 'passthrough');
    });

    // The app can be served from a sub-path (GitHub Pages at /MindSpark/, a
    // reverse proxy at /mindspark/). The API and the probe live under that
    // prefix, and the worker has to recognise them there, not only at the root.
    test('the API and the probe are recognised under the sub-path the worker is served from', async () => {
      const location = { origin: ORIGIN, href: ORIGIN + '/MindSpark/sw.js' };
      assert.equal(await resolve('/MindSpark/api/maps', { location }), 'passthrough');
      assert.equal(await resolve('/MindSpark/healthz', { location }), 'passthrough');
      assert.equal(await resolve('/MindSpark/app.js', { location }), 'NETWORK', 'app code is still network-first');
    });

    test('cross-origin requests are passed through', async () => {
      const { listeners } = loadWorker();
      let responded = null;
      listeners.fetch({
        request: {
          method: 'GET', url: 'https://api.github.com/user', mode: 'cors',
          headers: { get: () => null }, clone() { return this; },
        },
        respondWith: (p) => { responded = p; },
      });
      assert.equal(responded, null);
    });

    test('non-GET is passed through', async () => {
      const { listeners } = loadWorker();
      let responded = null;
      listeners.fetch({
        request: {
          method: 'POST', url: `${ORIGIN}/app.js`, mode: 'cors',
          headers: { get: () => null }, clone() { return this; },
        },
        respondWith: (p) => { responded = p; },
      });
      assert.equal(responded, null);
    });
  });

  describe('offline', () => {
    test('falls back to the cached copy when the network is down', async () => {
      const { listeners, cacheStore } = loadWorker();
      const url = `${ORIGIN}/app.js`;
      cacheStore.set(url, new Response('CACHED', { status: 200 }));
      // re-evaluate with a failing network
      const ctx = loadWorker();
      ctx.cacheStore.set(url, new Response('CACHED', { status: 200 }));
      // swap fetch for one that throws, the way an offline browser behaves
      let responded = null;
      const request = {
        method: 'GET', url, mode: 'cors',
        headers: { get: () => null }, clone() { return this; },
      };
      // rebuild a worker whose fetch rejects
      const offline = loadWorkerOffline();
      offline.cacheStore.set(url, new Response('CACHED', { status: 200 }));
      offline.listeners.fetch({ request, respondWith: (p) => { responded = p; } });
      assert.equal(await (await responded).text(), 'CACHED');
      assert.ok(listeners.fetch && ctx.listeners.fetch);
    });
  });
});

/** Same as loadWorker(), but the network is down. */
function loadWorkerOffline() {
  const listeners = {};
  const cacheStore = new Map();
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
  const sandbox = {
    URL, Response, console,
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location: { origin: ORIGIN },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({ put: async () => {} }),
      match: async (req) => cacheStore.get(keyOf(req)),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SW, 'utf8'), sandbox);
  return { listeners, cacheStore };
}
