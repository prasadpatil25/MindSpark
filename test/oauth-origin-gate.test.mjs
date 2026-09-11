// Issue #43: public/app.js ships the maintainer's OAuth App client id and
// worker URL, and oauthConfigured() only checked that both were non-empty. So
// any copy of public/ on its own domain (or localhost) showed a working-looking
// "Sign in with GitHub" that sent the user to authorize the maintainer's App
// with scope=repo, routed a repo-scoped token through the maintainer's worker,
// which then postMessage'd it to ITS configured origin - not the page that
// opened the popup - so the browser dropped it and the overlay sat there.
//
// Fix, both halves pinned here: GH_OAUTH.appOrigin names the one origin the
// worker delivers to and the button exists only there; and if a popup still
// closes with no result, the overlay says why instead of nothing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst, extractFunction } from './helpers/load-app-fns.mjs';

const SHIPPED = extractConst('GH_OAUTH');

const configured = (location, GH_OAUTH = SHIPPED) =>
  loadFns(['oauthConfigured'], { GH_OAUTH, location }).oauthConfigured();

const at = (origin) => { const u = new URL(origin); return { origin: u.origin, hostname: u.hostname }; };

describe('oauthConfigured - the button exists only on the origin the worker delivers to', () => {
  test('the shipped config names an appOrigin, and it is the maintainer deployment', () => {
    assert.ok(SHIPPED.appOrigin, 'appOrigin must ship alongside clientId/workerUrl');
    assert.equal(new URL(SHIPPED.appOrigin).origin, SHIPPED.appOrigin, 'appOrigin is a bare origin');
    assert.notEqual(new URL(SHIPPED.workerUrl).origin, SHIPPED.appOrigin, 'the app and the worker are two deploys');
  });

  test('true on the maintainer deployment itself', () => {
    assert.equal(configured(at(SHIPPED.appOrigin)), true);
  });

  test('false on localhost, on a fork\'s domain, and on any other origin (the #43 cases)', () => {
    for (const o of ['http://localhost:8765', 'http://127.0.0.1:3000', 'https://mindspark.example.org', 'https://evil.example', 'http://mindspark.githubpage.workers.dev']) {
      assert.equal(configured(at(o)), false, o);
    }
  });

  test('false on *.github.io even if someone sets appOrigin to it (Pages is token-only)', () => {
    const gh = { ...SHIPPED, appOrigin: 'https://someone.github.io' };
    assert.equal(configured(at('https://someone.github.io'), gh), false);
  });

  test('false when any of the three fields is blank or appOrigin is not a URL', () => {
    const here = at(SHIPPED.appOrigin);
    assert.equal(configured(here, { ...SHIPPED, clientId: '' }), false);
    assert.equal(configured(here, { ...SHIPPED, workerUrl: '' }), false);
    assert.equal(configured(here, { ...SHIPPED, appOrigin: '' }), false);
    assert.equal(configured(here, { ...SHIPPED, appOrigin: 'not a url' }), false);
    assert.equal(configured(here, { clientId: '', workerUrl: '', appOrigin: '' }), false, 'a blank config is token-only');
  });

  test('a deployer\'s own config works on their own origin, with a trailing slash or path tolerated', () => {
    const mine = { clientId: 'abc', workerUrl: 'https://w.example.workers.dev/', appOrigin: 'https://maps.example.com/app/' };
    assert.equal(configured(at('https://maps.example.com'), mine), true);
    assert.equal(configured(at('https://other.example.com'), mine), false);
  });
});

describe('watchOauthPopup - a popup that closes with no result is reported, not ignored', () => {
  function fakeTimers() {
    const intervals = new Map(), timeouts = [];
    let id = 0;
    return {
      T: {
        setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id; },
        clearInterval: (i) => { intervals.delete(i); },
        setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return ++id; },
      },
      tick() { for (const { fn } of [...intervals.values()]) fn(); },
      flushTimeouts() { while (timeouts.length) timeouts.shift().fn(); },
      get live() { return intervals.size; },
      get queued() { return timeouts.length; },
    };
  }
  const { watchOauthPopup } = loadFns(['watchOauthPopup']);

  test('closed popup + nonce still pending = the silent-failure message, once', () => {
    const f = fakeTimers();
    const pop = { closed: false };
    let silent = 0;
    watchOauthPopup(pop, () => true, () => silent++, f.T);
    f.tick(); assert.equal(silent, 0, 'open popup: nothing yet');
    pop.closed = true;
    f.tick();
    assert.equal(f.live, 0, 'polling stops once the popup is closed');
    assert.equal(f.queued, 1, 'a grace period is queued for the message still in flight');
    assert.equal(silent, 0);
    f.flushTimeouts();
    assert.equal(silent, 1);
  });

  test('a result that arrived (nonce cleared) is not reported as a failure', () => {
    const f = fakeTimers();
    const pop = { closed: true };
    let silent = 0;
    watchOauthPopup(pop, () => false, () => silent++, f.T);
    f.tick(); f.flushTimeouts();
    assert.equal(silent, 0);
  });

  test('a popup whose window object throws on access counts as closed', () => {
    const f = fakeTimers();
    const pop = { get closed() { throw new Error('cross-origin'); } };
    let silent = 0;
    watchOauthPopup(pop, () => true, () => silent++, f.T);
    f.tick(); f.flushTimeouts();
    assert.equal(silent, 1);
  });

  test('no popup means nothing to watch', () => {
    const f = fakeTimers();
    watchOauthPopup(null, () => true, () => { throw new Error('should not fire'); }, f.T);
    assert.equal(f.live, 0);
  });
});

describe('startGithubLogin wires the watcher', () => {
  test('the popup is watched against the state nonce, and a blocked popup stops early', () => {
    const src = extractFunction('startGithubLogin');
    assert.match(src, /watchOauthPopup\(pop,/);
    assert.match(src, /mindspark:oauth:state'\)===rnd/, 'pending = the nonce this attempt wrote is still there');
    assert.match(src, /showOauthSilentFailure\)/);
    assert.match(src, /if\(!pop\)\{[^\n]*return; \}/, 'a blocked popup is reported and not watched');
  });

  test('the failure message tells the user how to recover', () => {
    const src = extractFunction('showOauthSilentFailure');
    assert.match(src, /ALLOWED_ORIGIN/);
    assert.match(src, /Use a token below/);
    assert.match(src, /github\.com\/settings\/applications/);
  });
});
